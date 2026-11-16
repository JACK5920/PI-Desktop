/**
 * Apply the persisted network proxy to Chromium sessions, Node env, and
 * Electron `net.fetch` (D340 / ADR 0177).
 *
 * Chromium `proxyRules` cannot carry userinfo and cannot speak SOCKS5
 * username/password, so credentialed custom proxies are applied through a
 * loopback SOCKS5 relay (issue #490). Sidecar and curl keep the canonical
 * URL with credentials.
 */
import { app, net, session, type Session } from "electron";
import {
  applyProxyEnvAssignments,
  chromiumProxyConfig,
  effectiveProxyBypass,
  normalizeNetworkProxy,
  parseProxyUrl,
  proxyEnvAssignments,
  proxyHasCredentials,
  restoreProxyEnv,
  snapshotProxyEnv,
  validateNetworkProxy,
  type ChromiumProxyConfig,
  type NetworkProxySettings,
} from "@pi-desktop/shared";
import {
  startAuthenticatedProxyRelay,
  type AuthenticatedProxyRelay,
} from "@pi-desktop/agent-runtime";
import { applyUserEndpointPolicyFromAppSettings } from "./endpoint-policy";
import {
  startSystemProxyRelay,
  type SystemProxyRelay,
} from "@pi-desktop/agent-runtime/system-proxy-relay";

const originalEnv = snapshotProxyEnv(process.env);
let applied: NetworkProxySettings = { mode: "system" };
let fetchPatched = false;
let sessionHookInstalled = false;
let activeRelay: AuthenticatedProxyRelay | null = null;
let relayUpstreamHref: string | null = null;
let systemProxyRelay: SystemProxyRelay | null = null;
let systemProxyRelayStart: Promise<SystemProxyRelay> | null = null;

export async function ensureSystemProxyRelay(): Promise<string> {
  if (!systemProxyRelay) {
    const starting =
      systemProxyRelayStart ??
      (systemProxyRelayStart = startSystemProxyRelay((url) =>
        session.defaultSession.resolveProxy(url),
      ));
    try {
      systemProxyRelay = await starting;
    } finally {
      if (systemProxyRelayStart === starting) systemProxyRelayStart = null;
    }
  }
  return systemProxyRelay.url;
}

export function currentSystemProxyRelayUrl(): string | null {
  return systemProxyRelay?.url ?? null;
}

export async function disposeSystemProxyRelay(): Promise<void> {
  const pending = systemProxyRelayStart;
  const relay = systemProxyRelay ?? (pending ? await pending : null);
  systemProxyRelay = null;
  if (systemProxyRelayStart === pending) systemProxyRelayStart = null;
  await relay?.close();
}

export function currentNetworkProxy(): NetworkProxySettings {
  return applied;
}

export async function applyNetworkProxy(
  settings: unknown,
): Promise<NetworkProxySettings> {
  const next = normalizeNetworkProxy(
    settings && typeof settings === "object"
      ? (settings as { networkProxy?: unknown }).networkProxy ?? settings
      : settings,
  );
  applied = next;
  // Custom is the only mode that owns the process env. Switching to system or
  // direct must clear what a previous custom setting injected, otherwise the
  // engine keeps using a proxy the user just turned off.
  if (next.mode === "custom") applyProxyEnvAssignments(proxyEnvAssignments(next), process.env);
  else restoreProxyEnv(originalEnv, process.env);
  if (next.mode === "custom") {
    process.env.PI_DESKTOP_PROXY_JSON = JSON.stringify(next);
  } else {
    delete process.env.PI_DESKTOP_PROXY_JSON;
  }

  installSessionHook();
  const previous = activeRelay;
  const previousHref = relayUpstreamHref;
  let started: AuthenticatedProxyRelay | null = null;
  try {
    const resolved = await chromiumConfigFor(next, true);
    started = resolved.relay;
    activeRelay = started;
    relayUpstreamHref = credentialedHref(next);
    await applyResolvedConfig(resolved.config);
  } catch (error) {
    activeRelay = previous;
    relayUpstreamHref = previousHref;
    if (started && started !== previous) await started.close();
    throw error;
  }
  if (previous && previous !== started) await previous.close();
  installMainFetch();
  return next;
}

export async function applyNetworkProxyFromAppSettings(
  settings: unknown,
): Promise<NetworkProxySettings> {
  // The network policy and the proxy ride the same settings write, so one call
  // site mirrors both.
  applyUserEndpointPolicyFromAppSettings(settings);
  const record =
    settings && typeof settings === "object"
      ? (settings as { networkProxy?: unknown })
      : {};
  return applyNetworkProxy(record.networkProxy ?? { mode: "system" });
}

function installSessionHook(): void {
  if (sessionHookInstalled) return;
  sessionHookInstalled = true;
  app.on("session-created", (ses) => {
    void applyToSession(ses, chromiumConfigFromApplied());
  });
}

function chromiumConfigFromApplied(): ChromiumProxyConfig {
  const config = chromiumProxyConfig(applied);
  if (activeRelay && "proxyRules" in config) {
    return {
      proxyRules: activeRelay.url,
      proxyBypassRules: config.proxyBypassRules,
    };
  }
  return config;
}

function installMainFetch(): void {
  if (fetchPatched) return;
  fetchPatched = true;
  globalThis.fetch = net.fetch.bind(net) as typeof fetch;
}

async function applyResolvedConfig(config: ChromiumProxyConfig): Promise<void> {
  await applyToSession(session.defaultSession, config);
  try {
    await applyToSession(session.fromPartition("persist:work-browser"), config);
  } catch {
    // Partition may not exist yet; session-created will catch it.
  }
}

async function applyToSession(
  ses: Session,
  config: ChromiumProxyConfig,
): Promise<void> {
  await ses.setProxy(config);
}

type ResolvedChromiumProxy = {
  config: ChromiumProxyConfig;
  relay: AuthenticatedProxyRelay | null;
};

function credentialedHref(settings: NetworkProxySettings): string | null {
  if (settings.mode !== "custom") return null;
  const parsed = parseProxyUrl(settings.url ?? "");
  if (!parsed.ok || !proxyHasCredentials(parsed.value)) return null;
  return parsed.value.href;
}

async function chromiumConfigFor(
  settings: NetworkProxySettings,
  reuseExisting: boolean,
): Promise<ResolvedChromiumProxy> {
  const config = chromiumProxyConfig(settings);
  if (settings.mode !== "custom" || !("proxyRules" in config)) {
    return { config, relay: null };
  }
  const parsed = parseProxyUrl(settings.url ?? "");
  if (!parsed.ok || !proxyHasCredentials(parsed.value)) {
    return { config, relay: null };
  }
  if (
    reuseExisting &&
    activeRelay &&
    relayUpstreamHref === parsed.value.href
  ) {
    return {
      config: {
        proxyRules: activeRelay.url,
        proxyBypassRules: config.proxyBypassRules,
      },
      relay: activeRelay,
    };
  }
  const relay = await startAuthenticatedProxyRelay(parsed.value);
  return {
    config: {
      proxyRules: relay.url,
      proxyBypassRules: config.proxyBypassRules,
    },
    relay,
  };
}

const PROXY_TEST_URL = "https://github.com/robots.txt";
const PROXY_TEST_TIMEOUT_MS = 8_000;

export async function testNetworkProxy(
  settings: unknown,
): Promise<{ ok: boolean; error?: string }> {
  const validated = validateNetworkProxy(
    settings && typeof settings === "object" && "mode" in (settings as object)
      ? settings
      : normalizeNetworkProxy(settings),
  );
  if (!validated.ok) return { ok: false, error: validated.error };
  const partition = `proxy-test-${Date.now().toString(36)}`;
  const ses = session.fromPartition(partition);
  let relay: AuthenticatedProxyRelay | null = null;
  try {
    const resolved = await chromiumConfigFor(validated.value, false);
    relay = resolved.relay;
    await applyToSession(ses, resolved.config);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PROXY_TEST_TIMEOUT_MS);
    try {
      const res = await ses.fetch(PROXY_TEST_URL, {
        method: "GET",
        signal: controller.signal,
      });
      if (res.status >= 500) {
        return { ok: false, error: `HTTP ${res.status}` };
      }
      return { ok: true };
    } finally {
      clearTimeout(timer);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: message };
  } finally {
    await relay?.close();
  }
}

/**
 * Child engines (OMP, sidecars) never see Chromium's proxy settings; they only
 * read environment variables. Without this, the browser can finish an OAuth
 * login while the engine's token exchange leaves from the real region and is
 * rejected as `unsupported_country_region_territory`.
 */
// Providers that are reachable directly from mainland China. Listing them in
// NO_PROXY keeps domestic models fast even if the user's proxy runs in
// "global" mode; the proxy client usually routes these directly anyway.
const DIRECT_PROVIDER_HOSTS = [
  "localhost",
  "127.0.0.1",
  "::1",
  "bigmodel.cn",
  "kimi.com",
  "moonshot.cn",
  "deepseek.com",
  "aliyuncs.com",
  "volces.com",
  "baidubce.com",
  "siliconflow.cn",
  "minimax.chat",
  "xfyun.cn",
];

export async function applyProxyToChildEnv(env: NodeJS.ProcessEnv): Promise<void> {
  // "直连" means the user's own network stack is in charge (Clash/v2ray TUN,
  // system VPN, or env vars they configured themselves). Do not add anything:
  // a second proxy layer here breaks TUN routing and their bypass rules.
  if (applied.mode === "direct") return;
  const existing = ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy"].some((name) => Boolean(env[name]));
  if (!existing && applied.mode === "system") {
    try {
      const relay = await ensureSystemProxyRelay();
      env.HTTP_PROXY = relay;
      env.HTTPS_PROXY = relay;
      env.ALL_PROXY = relay;
    } catch {
      // A proxy that cannot be resolved must not block the engine from starting.
      return;
    }
  }
  // Merge instead of overwrite: respect a NO_PROXY the user already set, then
  // append the configured bypass list, local endpoints and domestic providers
  // so they never detour abroad.
  const current = String(env.NO_PROXY ?? env.no_proxy ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  const bypass = effectiveProxyBypass(applied)
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  env.NO_PROXY = [...new Set([...current, ...bypass, ...DIRECT_PROVIDER_HOSTS])].join(",");
}

export function assertCustomProxyUrl(url: string): string {
  const parsed = parseProxyUrl(url);
  if (!parsed.ok) {
    const err = new Error(parsed.error) as Error & { errorCode?: string };
    err.errorCode = "INVALID_PARAMS";
    throw err;
  }
  return parsed.value.href;
}
