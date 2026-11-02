import assert from "node:assert/strict";
import test from "node:test";
import { IPC } from "@pi-desktop/shared";
import { registerGitHubPrReviewIpc } from "../electron/main/ipc/github-pr-review-ipc.ts";

function dependencies() {
  const values = new Map();
  return {
    values,
    secrets: {
      getSecret: async (key) => values.get(key) ?? null,
      setSecret: async (key, value) => { values.set(key, value); },
      deleteSecret: async (key) => { values.delete(key); },
    },
    openExternal: async () => undefined,
  };
}

const summary = {
  number: 8,
  title: "Public fixture",
  state: "open",
  draft: false,
  user: { login: "author" },
  base: { ref: "main" },
  head: { ref: "feature", sha: "sha-8" },
  updated_at: "2026-11-02T00:00:00Z",
};

test("GitHub PR IPC resolves the conversation's local origin and serves only public reads", async () => {
  const handlers = new Map();
  const requests = [];
  const registrar = { handle: (channel, handler) => handlers.set(channel, handler) };
  const extras = dependencies();
  registerGitHubPrReviewIpc({
    registrar,
    sessionProjects: new Map([["session-1", "C:/work/project"]]),
    readOrigin: async (path) => {
      assert.equal(path, "C:/work/project");
      return "git@github.com:example/repo.git";
    },
    fetchImpl: async (url, init) => {
      requests.push({ url, init });
      return new Response(JSON.stringify([summary]), { status: 200 });
    },
    ...extras,
  });

  const result = await handlers.get(IPC.invoke.githubPullRequestList)({ sessionId: "session-1" });
  assert.equal(result.repository.fullName, "example/repo");
  assert.equal(result.pullRequests[0].number, 8);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].init.method, "GET");
  assert.equal(Object.keys(requests[0].init.headers).some((key) => key.toLowerCase() === "authorization"), false);
});

test("GitHub PR IPC rejects remote sessions and malformed pull-request selectors before network access", async () => {
  const handlers = new Map();
  let requests = 0;
  const extras = dependencies();
  registerGitHubPrReviewIpc({
    registrar: { handle: (channel, handler) => handlers.set(channel, handler) },
    sessionProjects: new Map([["session-1", "C:/work/project"]]),
    readOrigin: async () => "https://github.com/example/repo.git",
    fetchImpl: async () => { requests += 1; return new Response("[]"); },
    ...extras,
  });

  await assert.rejects(handlers.get(IPC.invoke.githubPullRequestList)({ sessionId: "remote:host:1" }), /local workspace/);
  await assert.rejects(handlers.get(IPC.invoke.githubPullRequestDetail)({ sessionId: "session-1", number: 0 }), /positive integer/);
  await assert.rejects(handlers.get(IPC.invoke.githubPrReviewComment)({
    sessionId: "session-1",
    number: 8,
    headSha: "sha-8",
    path: "src/a.ts",
    line: 1,
    side: "RIGHT",
    body: "Comment",
    token: "renderer-controlled-token",
  }), /review comment fields are invalid/);
  assert.equal(requests, 0);
});

test("authenticated GitHub App reads attach the token only in Main and never return it", async () => {
  const handlers = new Map();
  const requests = [];
  const extras = dependencies();
  extras.values.set("github-pr-review:app-config", JSON.stringify({
    clientId: "Iv1.8a61f9b3a7aba766",
    clientSecret: "client_secret_for_test_only",
  }));
  extras.values.set("github-pr-review:user-token", JSON.stringify({
    accessToken: "ghu_test_access_token_1234567890",
    login: "reviewer",
  }));
  registerGitHubPrReviewIpc({
    registrar: { handle: (channel, handler) => handlers.set(channel, handler) },
    sessionProjects: new Map([["session-1", "C:/work/project"]]),
    readOrigin: async () => "https://github.com/example/repo.git",
    fetchImpl: async (url, init) => {
      requests.push({ url, init });
      return new Response(JSON.stringify([summary]), { status: 200 });
    },
    ...extras,
  });

  const result = await handlers.get(IPC.invoke.githubPullRequestList)({ sessionId: "session-1" });
  assert.equal(new Headers(requests[0].init.headers).get("authorization"), "Bearer ghu_test_access_token_1234567890");
  assert.doesNotMatch(JSON.stringify(result), /ghu_test_access_token_1234567890|client_secret_for_test_only/);
});
