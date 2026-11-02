import assert from "node:assert/strict";
import test from "node:test";
import { createGitHubPrReviewAuthService } from "../electron/main/github-pr-review-auth.ts";

const APP_CONFIG_REF = "github-pr-review:app-config";
const APP_TOKEN_REF = "github-pr-review:user-token";
const credentials = { clientId: "Iv1.8a61f9b3a7aba766", clientSecret: "client_secret_for_test_only" };

function secretStore(seed = new Map()) {
  return {
    values: seed,
    getSecret: async (key) => seed.get(key) ?? null,
    setSecret: async (key, value) => { seed.set(key, value); },
    deleteSecret: async (key) => { seed.delete(key); },
  };
}

test("GitHub App authorization uses loopback state and PKCE, stores tokens outside the renderer, and supports sign-out", async () => {
  const store = secretStore();
  const requests = [];
  let openedUrl;
  const service = createGitHubPrReviewAuthService({
    secrets: store,
    now: () => 1_800_000_000_000,
    fetchImpl: async (url, init) => {
      requests.push({ url, init });
      if (url === "https://github.com/login/oauth/access_token") {
        return new Response(JSON.stringify({
          access_token: "ghu_access_token_for_test_1234567890",
          refresh_token: "ghr_refresh_token_for_test_1234567890",
          expires_in: 28_800,
          refresh_token_expires_in: 15_897_600,
        }), { status: 200 });
      }
      if (url === "https://api.github.com/user") {
        assert.equal(new Headers(init.headers).get("authorization"), "Bearer ghu_access_token_for_test_1234567890");
        return new Response(JSON.stringify({ login: "reviewer" }), { status: 200 });
      }
      throw new Error(`unexpected request ${url}`);
    },
    openExternal: async (url) => {
      openedUrl = new URL(url);
      const redirect = new URL(openedUrl.searchParams.get("redirect_uri"));
      redirect.searchParams.set("state", openedUrl.searchParams.get("state"));
      redirect.searchParams.set("code", "authorization-code-fixture");
      const response = await fetch(redirect);
      assert.equal(response.status, 200);
    },
  });

  const configured = await service.configure(credentials);
  assert.equal(configured.configured, true);
  assert.equal(configured.connected, false);
  assert.doesNotMatch(JSON.stringify(configured), /client_secret_for_test_only/);

  const started = await service.start();
  assert.equal(started.configured, true);
  assert.equal(openedUrl.origin, "https://github.com");
  assert.equal(openedUrl.pathname, "/login/oauth/authorize");
  assert.equal(openedUrl.searchParams.get("scope"), "offline_access");
  assert.equal(openedUrl.searchParams.get("code_challenge_method"), "S256");
  assert.equal(openedUrl.searchParams.get("client_id"), credentials.clientId);
  assert.equal(openedUrl.searchParams.get("redirect_uri").startsWith("http://127.0.0.1:"), true);
  assert.equal(openedUrl.searchParams.get("state").length >= 40, true);

  const connected = await service.wait();
  assert.equal(connected.pending, false);
  assert.equal(connected.connected, true);
  assert.equal(connected.login, "reviewer");
  assert.equal(requests[0].init.method, "POST");
  const exchangeBody = new URLSearchParams(requests[0].init.body);
  assert.equal(exchangeBody.get("client_id"), credentials.clientId);
  assert.equal(exchangeBody.get("client_secret"), credentials.clientSecret);
  assert.equal(typeof exchangeBody.get("code_verifier"), "string");
  assert.equal(JSON.parse(store.values.get(APP_TOKEN_REF)).accessToken, "ghu_access_token_for_test_1234567890");

  const disconnected = await service.disconnect();
  assert.equal(disconnected.connected, false);
  assert.equal(store.values.has(APP_TOKEN_REF), false);
  assert.equal(store.values.has(APP_CONFIG_REF), true);
});

test("expired GitHub App user tokens refresh once and rotate the encrypted token record", async () => {
  const now = 1_800_000_000_000;
  const store = secretStore(new Map([
    [APP_CONFIG_REF, JSON.stringify(credentials)],
    [APP_TOKEN_REF, JSON.stringify({
      accessToken: "ghu_old_access_token_for_test_123456",
      refreshToken: "ghr_old_refresh_token_for_test_123456",
      accessExpiresAt: now - 1,
      refreshExpiresAt: now + 10_000_000,
      login: "reviewer",
    })],
  ]));
  const requests = [];
  const service = createGitHubPrReviewAuthService({
    secrets: store,
    now: () => now,
    openExternal: async () => assert.fail("refresh must not open a browser"),
    fetchImpl: async (url, init) => {
      requests.push({ url, init });
      return new Response(JSON.stringify({
        access_token: "ghu_new_access_token_for_test_123456",
        refresh_token: "ghr_new_refresh_token_for_test_123456",
        expires_in: 28_800,
        refresh_token_expires_in: 15_897_600,
      }), { status: 200 });
    },
  });

  const [token, sameToken] = await Promise.all([service.accessToken(), service.accessToken()]);
  assert.equal(token, "ghu_new_access_token_for_test_123456");
  assert.equal(sameToken, token);
  assert.equal(requests.length, 1);
  const body = new URLSearchParams(requests[0].init.body);
  assert.equal(body.get("grant_type"), "refresh_token");
  assert.equal(body.get("refresh_token"), "ghr_old_refresh_token_for_test_123456");
  assert.equal(JSON.parse(store.values.get(APP_TOKEN_REF)).refreshToken, "ghr_new_refresh_token_for_test_123456");
});

test("temporary refresh failures preserve the rotating refresh token", async () => {
  const now = 1_800_000_000_000;
  const store = secretStore(new Map([
    [APP_CONFIG_REF, JSON.stringify(credentials)],
    [APP_TOKEN_REF, JSON.stringify({
      accessToken: "ghu_old_access_token_for_test_123456",
      refreshToken: "ghr_old_refresh_token_for_test_123456",
      accessExpiresAt: now - 1,
      refreshExpiresAt: now + 10_000_000,
      login: "reviewer",
    })],
  ]));
  const service = createGitHubPrReviewAuthService({
    secrets: store,
    now: () => now,
    openExternal: async () => assert.fail("refresh must not open a browser"),
    fetchImpl: async () => new Response("temporarily unavailable", { status: 503 }),
  });

  await assert.rejects(service.accessToken(), /temporarily unavailable/);
  assert.equal(JSON.parse(store.values.get(APP_TOKEN_REF)).refreshToken, "ghr_old_refresh_token_for_test_123456");
});

test("GitHub authorization rejects malformed app credentials and cancellation closes the loopback flow", async () => {
  const store = secretStore();
  const service = createGitHubPrReviewAuthService({
    secrets: store,
    openExternal: async () => undefined,
    fetchImpl: async () => assert.fail("cancelled flow must not exchange a token"),
  });

  await assert.rejects(service.configure({ clientId: "x", clientSecret: "short" }), /client ID and client secret/);
  await assert.rejects(service.configure({ ...credentials, token: "unexpected" }), /client ID and client secret/);
  assert.equal((await service.configure(credentials)).configured, true, "GitHub client IDs containing dots are valid");
  assert.equal((await service.start()).pending, true);
  assert.equal((await service.cancel()).pending, false);
  await assert.rejects(service.wait(), /cancelled/);
  await service.clearConfiguration();
  assert.deepEqual(await service.status(), {
    configured: false,
    connected: false,
    pending: false,
  });
});

test("cancelling during profile lookup never persists a token after the flow settles", async () => {
  const store = secretStore();
  let resolveProfile;
  const profile = new Promise((resolve) => { resolveProfile = resolve; });
  const service = createGitHubPrReviewAuthService({
    secrets: store,
    openExternal: async (url) => {
      const authorize = new URL(url);
      const redirect = new URL(authorize.searchParams.get("redirect_uri"));
      redirect.searchParams.set("state", authorize.searchParams.get("state"));
      redirect.searchParams.set("code", "authorization-code-fixture");
      await fetch(redirect);
    },
    fetchImpl: async (url) => {
      if (url === "https://github.com/login/oauth/access_token") {
        return new Response(JSON.stringify({ access_token: "ghu_access_token_for_test_1234567890" }), { status: 200 });
      }
      return profile;
    },
  });

  await service.configure(credentials);
  await service.start();
  const cancellation = service.cancel();
  resolveProfile(new Response(JSON.stringify({ login: "reviewer" }), { status: 200 }));
  await cancellation;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(store.values.has(APP_TOKEN_REF), false);
});
