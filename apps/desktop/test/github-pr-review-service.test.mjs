import assert from "node:assert/strict";
import test from "node:test";
import {
  createGitHubPrReviewService,
  GitHubPrReviewError,
  parseGitHubRemote,
} from "../electron/main/github-pr-review-service.ts";

const repo = { owner: "vastsa", name: "PI-Desktop", fullName: "vastsa/PI-Desktop" };

function jsonResponse(value, init = {}) {
  return new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
    ...init,
  });
}

function pullRequest() {
  return {
    number: 41,
    title: "Review fixture",
    state: "open",
    draft: false,
    user: { login: "fixture-user" },
    base: { ref: "main" },
    head: { ref: "feature", sha: "head-sha-41" },
    updated_at: "2026-11-02T00:00:00Z",
  };
}

test("only GitHub.com SSH and HTTPS origins resolve to public repository identities", () => {
  assert.deepEqual(parseGitHubRemote("https://github.com/JACK5920/PI-Desktop.git"), {
    owner: "JACK5920", name: "PI-Desktop", fullName: "JACK5920/PI-Desktop",
  });
  assert.deepEqual(parseGitHubRemote("git@github.com:JACK5920/PI-Desktop.git"), {
    owner: "JACK5920", name: "PI-Desktop", fullName: "JACK5920/PI-Desktop",
  });
  assert.deepEqual(parseGitHubRemote("ssh://git@github.com/JACK5920/PI-Desktop.git"), {
    owner: "JACK5920", name: "PI-Desktop", fullName: "JACK5920/PI-Desktop",
  });
  assert.equal(parseGitHubRemote("https://github.com.evil.invalid/user/repo.git"), null);
  assert.equal(parseGitHubRemote("https://gitlab.com/user/repo.git"), null);
  assert.equal(parseGitHubRemote("git://github.com/user/repo.git"), null);
  assert.equal(parseGitHubRemote("https://user:token@github.com/user/repo.git"), null);
  assert.equal(parseGitHubRemote("git@github.com:../repo.git"), null);
});

test("PR listing uses the fixed unauthenticated public API and bounded open-PR page", async () => {
  const requests = [];
  const service = createGitHubPrReviewService(async (url, init) => {
    requests.push({ url, init });
    return jsonResponse([pullRequest()]);
  });

  const result = await service.list(repo);
  assert.equal(result.repository.fullName, "vastsa/PI-Desktop");
  assert.equal(result.pullRequests.length, 1);
  assert.equal(result.pullRequests[0].htmlUrl, "https://github.com/vastsa/PI-Desktop/pull/41");
  assert.equal(requests[0].url,
    "https://api.github.com/repos/vastsa/PI-Desktop/pulls?state=open&sort=updated&direction=desc&per_page=50");
  assert.equal(requests[0].init.method, "GET");
  assert.equal(requests[0].init.redirect, "error");
  assert.equal(Object.keys(requests[0].init.headers).some((key) => key.toLowerCase() === "authorization"), false);
});

test("PR detail includes bounded file patches and normalized check-run/status state", async () => {
  const requests = [];
  const service = createGitHubPrReviewService(async (url, init) => {
    requests.push({ url, init });
    const pathname = new URL(url).pathname;
    if (pathname.endsWith("/pulls/41")) return jsonResponse(pullRequest());
    if (pathname.endsWith("/pulls/41/files")) {
      return jsonResponse([{
        filename: "src/example.ts",
        status: "modified",
        additions: 1,
        deletions: 1,
        patch: "@@ -1 +1 @@\n-old\n+new",
      }]);
    }
    if (pathname.endsWith("/check-runs")) {
      return jsonResponse({ check_runs: [
        { name: "unit", status: "completed", conclusion: "success" },
        { name: "build", status: "in_progress", conclusion: null },
      ] });
    }
    if (pathname.endsWith("/status")) return jsonResponse({ state: "success", statuses: [] });
    throw new Error(`unexpected endpoint ${url}`);
  });

  const result = await service.detail(repo, 41);
  assert.equal(result.pullRequest.headSha, "head-sha-41");
  assert.equal(result.files.length, 1);
  assert.equal(result.files[0].patch, "@@ -1 +1 @@\n-old\n+new");
  assert.equal(result.filesTruncated, false);
  assert.equal(result.checksState, "pending");
  assert.deepEqual(result.checks.map(({ name, state }) => [name, state]), [
    ["unit", "success"], ["build", "pending"],
  ]);
  assert.equal(requests.length, 4);
  assert.ok(requests.every(({ url }) => new URL(url).origin === "https://api.github.com"));
  assert.ok(requests.every(({ init }) => init.method === "GET"));
});

test("public API errors do not disclose remote or response bodies", async () => {
  const rateLimited = createGitHubPrReviewService(async () => new Response("secret body", {
    status: 403,
    headers: { "x-ratelimit-remaining": "0" },
  }));
  await assert.rejects(rateLimited.list(repo), (error) => {
    assert.ok(error instanceof GitHubPrReviewError);
    assert.equal(error.code, "rate_limited");
    assert.doesNotMatch(error.message, /secret body/);
    return true;
  });

  const tooLarge = createGitHubPrReviewService(async () => new Response("x".repeat(3_000_001)));
  await assert.rejects(tooLarge.list(repo), (error) => {
    assert.ok(error instanceof GitHubPrReviewError);
    assert.equal(error.code, "response_too_large");
    return true;
  });
});
