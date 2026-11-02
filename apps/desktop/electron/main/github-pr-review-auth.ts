import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { GitHubPrReviewAuthStatus, GitHubPrReviewAppCredentials } from "@pi-desktop/shared";
import { GitHubPrReviewError, type GitHubFetch } from "./github-pr-review-service.ts";

const API_ROOT = "https://api.github.com";
const OAUTH_ROOT = "https://github.com";
const APP_CONFIG_REF = "github-pr-review:app-config";
const APP_TOKEN_REF = "github-pr-review:user-token";
const MAX_OAUTH_BODY_BYTES = 128_000;
const AUTH_FLOW_TTL_MS = 5 * 60_000;
const TOKEN_REFRESH_MARGIN_MS = 90_000;

export type GitHubPrSecretStore = {
  getSecret(secretRef: string): Promise<string | null>;
  setSecret(secretRef: string, value: string): Promise<void>;
  deleteSecret(secretRef: string): Promise<void>;
};

type AppConfig = GitHubPrReviewAppCredentials;
type StoredToken = {
  accessToken: string;
  refreshToken?: string;
  accessExpiresAt?: number;
  refreshExpiresAt?: number;
  login: string;
};
type JsonRecord = Record<string, unknown>;
type OAuthCallback = { promise: Promise<string>; redirectUri: string; cancel(): void };
type ActiveFlow = {
  pending: boolean;
  cancelled: boolean;
  errorCode: GitHubPrReviewError["code"] | null;
  completion: Promise<void>;
  cancel(): void;
};

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: JsonRecord, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function safeMessage(error: unknown, fallback: GitHubPrReviewError["code"]): GitHubPrReviewError {
  if (error instanceof GitHubPrReviewError) return error;
  return new GitHubPrReviewError(fallback, "GitHub authorization failed");
}

function validClientId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9._-]{8,128}$/.test(value);
}

function validClientSecret(value: unknown): value is string {
  return typeof value === "string" && value.length >= 10 && value.length <= 512
    && !/[\u0000-\u0020\u007f]/.test(value);
}

function configFromUnknown(value: unknown): AppConfig | null {
  if (!isRecord(value) || !hasExactKeys(value, ["clientId", "clientSecret"])
    || !validClientId(value.clientId) || !validClientSecret(value.clientSecret)) return null;
  return { clientId: value.clientId, clientSecret: value.clientSecret };
}

function storedTokenFromUnknown(value: unknown): StoredToken | null {
  if (!isRecord(value)
    || typeof value.accessToken !== "string" || value.accessToken.length < 16 || value.accessToken.length > 4096
    || typeof value.login !== "string" || !/^[A-Za-z0-9-]{1,100}$/.test(value.login)) return null;
  if (value.refreshToken !== undefined
    && (typeof value.refreshToken !== "string" || value.refreshToken.length < 16 || value.refreshToken.length > 4096)) return null;
  const accessExpiresAt = Number.isSafeInteger(value.accessExpiresAt) ? Number(value.accessExpiresAt) : undefined;
  const refreshExpiresAt = Number.isSafeInteger(value.refreshExpiresAt) ? Number(value.refreshExpiresAt) : undefined;
  return {
    accessToken: value.accessToken,
    login: value.login,
    ...(typeof value.refreshToken === "string" ? { refreshToken: value.refreshToken } : {}),
    ...(accessExpiresAt === undefined ? {} : { accessExpiresAt }),
    ...(refreshExpiresAt === undefined ? {} : { refreshExpiresAt }),
  };
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function isLoopbackAddress(value: string | undefined): boolean {
  return value === "127.0.0.1" || value === "::ffff:127.0.0.1";
}

function htmlResponse(response: import("node:http").ServerResponse, status: number, body: string): void {
  response.writeHead(status, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(`<!doctype html><meta charset="utf-8"><title>PI-Desktop</title><p>${body}</p>`);
}

async function callbackListener(expectedState: string): Promise<OAuthCallback> {
  let resolveCode!: (code: string) => void;
  let rejectCode!: (error: GitHubPrReviewError) => void;
  let settled = false;
  let timer: NodeJS.Timeout | undefined;
  const promise = new Promise<string>((resolve, reject) => {
    resolveCode = resolve;
    rejectCode = reject;
  });
  // A cancelled or timed-out flow may have no renderer waiter. This observer
  // prevents an unhandled rejection while preserving the original promise.
  void promise.catch(() => undefined);
  const server: Server = createServer((request, response) => {
    if (request.method !== "GET" || !isLoopbackAddress(request.socket.remoteAddress)) {
      htmlResponse(response, 404, "Not found.");
      return;
    }
    let url: URL;
    try {
      url = new URL(request.url ?? "/", "http://127.0.0.1");
    } catch {
      htmlResponse(response, 400, "Invalid authorization response.");
      return;
    }
    if (url.pathname !== "/github/callback") {
      htmlResponse(response, 404, "Not found.");
      return;
    }
    const returnedState = url.searchParams.get("state") ?? "";
    if (!safeEqual(expectedState, returnedState)) {
      htmlResponse(response, 400, "Authorization state did not match. Return to PI-Desktop and try again.");
      return;
    }
    const error = url.searchParams.get("error");
    if (error) {
      htmlResponse(response, 200, "Authorization was not completed. You can return to PI-Desktop.");
      finishReject(new GitHubPrReviewError("auth_cancelled", "GitHub authorization was not approved"));
      return;
    }
    const code = url.searchParams.get("code") ?? "";
    if (!code || code.length > 2048 || /[\u0000-\u0020\u007f]/.test(code)) {
      htmlResponse(response, 400, "Invalid authorization response. Return to PI-Desktop and try again.");
      return;
    }
    htmlResponse(response, 200, "GitHub authorization complete. You can close this page and return to PI-Desktop.");
    finishResolve(code);
  });

  const close = () => {
    if (timer) clearTimeout(timer);
    if (server.listening) server.close();
  };
  const finishResolve = (code: string) => {
    if (settled) return;
    settled = true;
    close();
    resolveCode(code);
  };
  const finishReject = (error: GitHubPrReviewError) => {
    if (settled) return;
    settled = true;
    close();
    rejectCode(error);
  };

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    finishReject(new GitHubPrReviewError("auth_failed", "Could not start the local GitHub authorization callback"));
    throw new GitHubPrReviewError("auth_failed", "Could not start the local GitHub authorization callback");
  }
  const redirectUri = `http://127.0.0.1:${address.port}/github/callback`;
  timer = setTimeout(() => finishReject(new GitHubPrReviewError("auth_expired", "GitHub authorization request expired")), AUTH_FLOW_TTL_MS);
  timer.unref?.();
  return {
    promise,
    redirectUri,
    cancel: () => finishReject(new GitHubPrReviewError("auth_cancelled", "GitHub authorization was cancelled")),
  };
}

async function readBoundedJson(response: Response): Promise<unknown> {
  const length = Number(response.headers.get("content-length"));
  if (Number.isFinite(length) && length > MAX_OAUTH_BODY_BYTES) {
    await response.body?.cancel();
    throw new GitHubPrReviewError("response_too_large", "GitHub authorization response exceeded its limit");
  }
  const reader = response.body?.getReader();
  if (!reader) {
    const text = await response.text();
    if (Buffer.byteLength(text) > MAX_OAUTH_BODY_BYTES) throw new GitHubPrReviewError("response_too_large", "GitHub authorization response exceeded its limit");
    return parseJson(text);
  }
  const decoder = new TextDecoder();
  let size = 0;
  let text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_OAUTH_BODY_BYTES) {
        await reader.cancel();
        throw new GitHubPrReviewError("response_too_large", "GitHub authorization response exceeded its limit");
      }
      text += decoder.decode(value, { stream: true });
    }
    return parseJson(text + decoder.decode());
  } finally {
    reader.releaseLock();
  }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new GitHubPrReviewError("auth_failed", "GitHub returned an invalid authorization response");
  }
}

function expiresAt(value: unknown, now: number): number | undefined {
  return Number.isSafeInteger(value) && Number(value) > 0 && Number(value) <= 31_536_000
    ? now + Number(value) * 1000
    : undefined;
}

export function createGitHubPrReviewAuthService(dependencies: {
  secrets: GitHubPrSecretStore;
  fetchImpl: GitHubFetch;
  openExternal: (url: string) => Promise<void>;
  now?: () => number;
}) {
  const now = dependencies.now ?? Date.now;
  let flow: ActiveFlow | null = null;
  let starting = false;
  let refreshPromise: Promise<StoredToken | null> | null = null;

  async function config(): Promise<AppConfig | null> {
    const raw = await dependencies.secrets.getSecret(APP_CONFIG_REF);
    if (!raw) return null;
    try {
      return configFromUnknown(JSON.parse(raw) as unknown);
    } catch {
      return null;
    }
  }

  async function token(): Promise<StoredToken | null> {
    const raw = await dependencies.secrets.getSecret(APP_TOKEN_REF);
    if (!raw) return null;
    try {
      return storedTokenFromUnknown(JSON.parse(raw) as unknown);
    } catch {
      return null;
    }
  }

  async function storeToken(value: StoredToken): Promise<void> {
    await dependencies.secrets.setSecret(APP_TOKEN_REF, JSON.stringify(value));
  }

  async function requestJson(url: string, init: RequestInit): Promise<unknown> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);
    try {
      let response: Response;
      try {
        response = await dependencies.fetchImpl(url, { ...init, redirect: "error", signal: controller.signal });
      } catch {
        throw new GitHubPrReviewError("unavailable", "Could not reach GitHub");
      }
      if (!response.ok) {
        await response.body?.cancel();
        if (response.status === 401) throw new GitHubPrReviewError("auth_required", "GitHub authorization expired or was revoked");
        if (response.status === 403) throw new GitHubPrReviewError("permission_denied", "GitHub denied the requested permission");
        if (response.status >= 500) throw new GitHubPrReviewError("unavailable", "GitHub authorization service is temporarily unavailable");
        throw new GitHubPrReviewError("auth_failed", "GitHub authorization failed");
      }
      return await readBoundedJson(response);
    } finally {
      clearTimeout(timeout);
    }
  }

  async function exchangeToken(input: {
    app: AppConfig;
    code: string;
    redirectUri: string;
    codeVerifier: string;
  }): Promise<Omit<StoredToken, "login">> {
    const form = new URLSearchParams({
      client_id: input.app.clientId,
      client_secret: input.app.clientSecret,
      code: input.code,
      redirect_uri: input.redirectUri,
      code_verifier: input.codeVerifier,
    });
    const value = await requestJson(`${OAUTH_ROOT}/login/oauth/access_token`, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": "PI-Desktop",
      },
      body: form.toString(),
    });
    if (!isRecord(value) || typeof value.access_token !== "string" || value.access_token.length < 16 || value.access_token.length > 4096) {
      throw new GitHubPrReviewError("auth_failed", "GitHub did not return a valid access token");
    }
    const at = now();
    return {
      accessToken: value.access_token,
      ...(typeof value.refresh_token === "string" && value.refresh_token.length >= 16 && value.refresh_token.length <= 4096
        ? { refreshToken: value.refresh_token }
        : {}),
      ...(expiresAt(value.expires_in, at) === undefined ? {} : { accessExpiresAt: expiresAt(value.expires_in, at) }),
      ...(expiresAt(value.refresh_token_expires_in, at) === undefined ? {} : { refreshExpiresAt: expiresAt(value.refresh_token_expires_in, at) }),
    };
  }

  async function userLogin(accessToken: string): Promise<string> {
    const value = await requestJson(`${API_ROOT}/user`, {
      method: "GET",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${accessToken}`,
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "PI-Desktop",
      },
    });
    if (!isRecord(value) || typeof value.login !== "string" || !/^[A-Za-z0-9-]{1,100}$/.test(value.login)) {
      throw new GitHubPrReviewError("auth_failed", "GitHub returned an invalid account profile");
    }
    return value.login;
  }

  async function finishFlow(active: ActiveFlow, app: AppConfig, callback: OAuthCallback, codeVerifier: string): Promise<void> {
    try {
      const code = await callback.promise;
      const tokenResult = await exchangeToken({ app, code, redirectUri: callback.redirectUri, codeVerifier });
      if (active.cancelled) return;
      const login = await userLogin(tokenResult.accessToken);
      if (active.cancelled) return;
      await storeToken({ ...tokenResult, login });
    } catch (error) {
      active.errorCode = safeMessage(error, "auth_failed").code;
    } finally {
      active.pending = false;
    }
  }

  async function refreshedToken(): Promise<StoredToken | null> {
    const [app, saved] = await Promise.all([config(), token()]);
    if (!saved) return null;
    if (!saved.accessExpiresAt || saved.accessExpiresAt > now() + TOKEN_REFRESH_MARGIN_MS) return saved;
    if (!saved.refreshToken || (saved.refreshExpiresAt !== undefined && saved.refreshExpiresAt <= now())) {
      await dependencies.secrets.deleteSecret(APP_TOKEN_REF);
      return null;
    }
    if (!app) return null;
    const form = new URLSearchParams({
      client_id: app.clientId,
      client_secret: app.clientSecret,
      grant_type: "refresh_token",
      refresh_token: saved.refreshToken,
    });
    const value = await requestJson(`${OAUTH_ROOT}/login/oauth/access_token`, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": "PI-Desktop",
      },
      body: form.toString(),
    }).catch(async (error: unknown) => {
      if (error instanceof GitHubPrReviewError && error.code === "unavailable") throw error;
      await dependencies.secrets.deleteSecret(APP_TOKEN_REF);
      throw safeMessage(error, "auth_required");
    });
    if (!isRecord(value) || typeof value.access_token !== "string" || value.access_token.length < 16 || value.access_token.length > 4096) {
      await dependencies.secrets.deleteSecret(APP_TOKEN_REF);
      throw new GitHubPrReviewError("auth_required", "GitHub authorization expired; sign in again");
    }
    const at = now();
    const next: StoredToken = {
      accessToken: value.access_token,
      login: saved.login,
      ...(typeof value.refresh_token === "string" && value.refresh_token.length >= 16 && value.refresh_token.length <= 4096
        ? { refreshToken: value.refresh_token }
        : {}),
      ...(expiresAt(value.expires_in, at) === undefined ? {} : { accessExpiresAt: expiresAt(value.expires_in, at) }),
      ...(expiresAt(value.refresh_token_expires_in, at) === undefined ? {} : { refreshExpiresAt: expiresAt(value.refresh_token_expires_in, at) }),
    };
    await storeToken(next);
    return next;
  }

  async function currentToken(): Promise<StoredToken | null> {
    if (!refreshPromise) {
      refreshPromise = refreshedToken().finally(() => { refreshPromise = null; });
    }
    return refreshPromise;
  }

  async function status(): Promise<GitHubPrReviewAuthStatus> {
    const [app, saved] = await Promise.all([config(), token()]);
    const tokenUsable = Boolean(saved && (
      saved.accessExpiresAt === undefined
      || saved.accessExpiresAt > now()
      || (saved.refreshToken && (saved.refreshExpiresAt === undefined || saved.refreshExpiresAt > now()))
    ));
    return {
      configured: app !== null,
      connected: tokenUsable,
      pending: starting || (flow?.pending ?? false),
      ...(tokenUsable && saved ? { login: saved.login } : {}),
      ...(tokenUsable && saved?.accessExpiresAt ? { expiresAt: saved.accessExpiresAt } : {}),
    };
  }

  return {
    async status() {
      return status();
    },

    async configure(credentials: unknown) {
      const app = configFromUnknown(credentials);
      if (!app) throw new GitHubPrReviewError("invalid_credentials", "A valid GitHub App client ID and client secret are required");
      flow?.cancel();
      await dependencies.secrets.setSecret(APP_CONFIG_REF, JSON.stringify(app));
      await dependencies.secrets.deleteSecret(APP_TOKEN_REF);
      return status();
    },

    async clearConfiguration() {
      flow?.cancel();
      await Promise.all([
        dependencies.secrets.deleteSecret(APP_CONFIG_REF),
        dependencies.secrets.deleteSecret(APP_TOKEN_REF),
      ]);
      return status();
    },

    async disconnect() {
      flow?.cancel();
      await dependencies.secrets.deleteSecret(APP_TOKEN_REF);
      return status();
    },

    async start() {
      if (starting || flow?.pending) throw new GitHubPrReviewError("flow_pending", "GitHub sign-in is already in progress");
      starting = true;
      try {
        const app = await config();
        if (!app) throw new GitHubPrReviewError("invalid_credentials", "Configure a GitHub App before signing in");
        const state = randomBytes(32).toString("base64url");
        const codeVerifier = randomBytes(32).toString("base64url");
        const codeChallenge = createHash("sha256").update(codeVerifier).digest("base64url");
        const callback = await callbackListener(state);
        const authorizeUrl = new URL(`${OAUTH_ROOT}/login/oauth/authorize`);
        authorizeUrl.searchParams.set("client_id", app.clientId);
        authorizeUrl.searchParams.set("redirect_uri", callback.redirectUri);
        authorizeUrl.searchParams.set("response_type", "code");
        authorizeUrl.searchParams.set("scope", "offline_access");
        authorizeUrl.searchParams.set("state", state);
        authorizeUrl.searchParams.set("code_challenge", codeChallenge);
        authorizeUrl.searchParams.set("code_challenge_method", "S256");
        authorizeUrl.searchParams.set("allow_signup", "false");
        const active: ActiveFlow = {
          pending: true,
          cancelled: false,
          errorCode: null,
          completion: Promise.resolve(),
          cancel: () => {
            active.cancelled = true;
            callback.cancel();
          },
        };
        flow = active;
        active.completion = finishFlow(active, app, callback, codeVerifier);
        try {
          await dependencies.openExternal(authorizeUrl.href);
        } catch {
          active.cancel();
          await active.completion;
          throw new GitHubPrReviewError("auth_failed", "Could not open GitHub authorization in the system browser");
        }
        return status();
      } finally {
        starting = false;
      }
    },

    async wait() {
      const active = flow;
      if (!active) return status();
      await active.completion;
      if (active.errorCode) {
        const messages: Partial<Record<GitHubPrReviewError["code"], string>> = {
          auth_cancelled: "GitHub authorization was cancelled",
          auth_expired: "GitHub authorization request expired",
          auth_required: "GitHub authorization expired; sign in again",
          invalid_credentials: "GitHub App credentials are invalid",
        };
        throw new GitHubPrReviewError(active.errorCode, messages[active.errorCode] ?? "GitHub authorization failed");
      }
      return status();
    },

    async cancel() {
      flow?.cancel();
      if (flow) await flow.completion;
      return status();
    },

    async accessToken(): Promise<string | null> {
      return (await currentToken())?.accessToken ?? null;
    },
  };
}
