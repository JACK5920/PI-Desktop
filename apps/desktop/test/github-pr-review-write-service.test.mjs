import assert from "node:assert/strict";
import test from "node:test";
import { createGitHubPrReviewWriteService } from "../electron/main/github-pr-review-write-service.ts";

const repository = { owner: "example", name: "repo", fullName: "example/repo" };
const headSha = "a".repeat(40);

function pullRequest(sha = headSha) {
  return {
    number: 41,
    title: "Write fixture",
    state: "open",
    draft: false,
    user: { login: "author" },
    base: { ref: "main" },
    head: { ref: "feature", sha },
    updated_at: "2026-11-03T00:00:00Z",
  };
}

function fixtureFetch(options = {}) {
  const requests = [];
  const fetchImpl = async (url, init) => {
    requests.push({ url, init });
    const path = new URL(url).pathname;
    if (path.endsWith("/pulls/41") && init.method === "GET") return new Response(JSON.stringify(pullRequest(options.headSha)), { status: 200 });
    if (path.endsWith("/pulls/41/files")) {
      return new Response(JSON.stringify([{
        filename: "src/example.ts",
        status: "modified",
        additions: 1,
        deletions: 1,
        patch: "@@ -1 +1 @@\n-old line\n+new line",
      }]), { status: 200 });
    }
    if (path.endsWith("/check-runs")) return new Response(JSON.stringify({ check_runs: [] }), { status: 200 });
    if (path.endsWith("/status")) return new Response(JSON.stringify({ state: "success" }), { status: 200 });
    if (init.method === "POST") return new Response(JSON.stringify({ html_url: "https://github.com/example/repo/pull/41" }), { status: 200 });
    throw new Error(`unexpected request ${url}`);
  };
  return { fetchImpl, requests };
}

test("line comments require an authenticated current head and a changed-line anchor", async () => {
  const { fetchImpl, requests } = fixtureFetch();
  const service = createGitHubPrReviewWriteService({
    fetchImpl,
    getAccessToken: async () => "ghu_test_access_token_1234567890",
  });

  const result = await service.comment(repository, {
    sessionId: "session-1",
    number: 41,
    headSha,
    path: "src/example.ts",
    line: 1,
    side: "RIGHT",
    body: "Please keep this behavior.",
  });
  assert.equal(result.htmlUrl, "https://github.com/example/repo/pull/41");
  const post = requests.find(({ init }) => init.method === "POST");
  assert.ok(post);
  assert.equal(post.url, "https://api.github.com/repos/example/repo/pulls/41/comments");
  assert.equal(new Headers(post.init.headers).get("authorization"), "Bearer ghu_test_access_token_1234567890");
  assert.deepEqual(JSON.parse(post.init.body), {
    body: "Please keep this behavior.",
    commit_id: headSha,
    path: "src/example.ts",
    line: 1,
    side: "RIGHT",
  });
  assert.ok(requests.every(({ url }) => new URL(url).origin === "https://api.github.com"));

  const beforeInvalid = requests.length;
  await assert.rejects(service.comment(repository, {
    sessionId: "session-1",
    number: 41,
    headSha,
    path: "src/example.ts",
    line: 2,
    side: "RIGHT",
    body: "This is not the deleted line number.",
  }), /no longer in the pull-request diff/);
  assert.equal(requests.slice(beforeInvalid).some(({ init }) => init.method === "POST"), false);
});

test("review summaries submit COMMENT, APPROVE, or REQUEST_CHANGES only at the current pull-request head", async () => {
  const { fetchImpl, requests } = fixtureFetch();
  const service = createGitHubPrReviewWriteService({
    fetchImpl,
    getAccessToken: async () => "ghu_test_access_token_1234567890",
  });

  await service.review(repository, {
    sessionId: "session-1",
    number: 41,
    headSha,
    event: "APPROVE",
    body: "Looks good to me.",
  });
  const post = requests.find(({ init }) => init.method === "POST");
  assert.ok(post);
  assert.equal(post.url, "https://api.github.com/repos/example/repo/pulls/41/reviews");
  assert.deepEqual(JSON.parse(post.init.body), {
    commit_id: headSha,
    body: "Looks good to me.",
    event: "APPROVE",
  });

  const stale = fixtureFetch({ headSha: "b".repeat(40) });
  const staleService = createGitHubPrReviewWriteService({
    fetchImpl: stale.fetchImpl,
    getAccessToken: async () => "ghu_test_access_token_1234567890",
  });
  await assert.rejects(staleService.review(repository, {
    sessionId: "session-1",
    number: 41,
    headSha,
    event: "REQUEST_CHANGES",
    body: "Please address the concern.",
  }), /pull request changed/);
  assert.equal(stale.requests.some(({ init }) => init.method === "POST"), false);
});

test("GitHub writes fail closed when signed out", async () => {
  let requests = 0;
  const service = createGitHubPrReviewWriteService({
    fetchImpl: async () => { requests += 1; return new Response("{}", { status: 200 }); },
    getAccessToken: async () => null,
  });
  await assert.rejects(service.review(repository, {
    sessionId: "session-1",
    number: 41,
    headSha,
    event: "COMMENT",
    body: "Review text.",
  }), /Sign in to GitHub/);
  assert.equal(requests, 0);
});

test("closed pull requests cannot receive comments or reviews", async () => {
  const closed = fixtureFetch();
  const originalFetch = closed.fetchImpl;
  const service = createGitHubPrReviewWriteService({
    fetchImpl: async (url, init) => {
      if (new URL(url).pathname.endsWith("/pulls/41") && init.method === "GET") {
        return new Response(JSON.stringify({ ...pullRequest(), state: "closed" }), { status: 200 });
      }
      return originalFetch(url, init);
    },
    getAccessToken: async () => "ghu_test_access_token_1234567890",
  });

  await assert.rejects(service.review(repository, {
    sessionId: "session-1",
    number: 41,
    headSha,
    event: "COMMENT",
    body: "Review text.",
  }), /Only open pull requests/);
  assert.equal(closed.requests.some(({ init }) => init.method === "POST"), false);
});
