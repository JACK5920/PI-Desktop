import { net } from "electron";
import { isOmpCustomModelApi, normalizeOmpCustomModelBaseUrl, type OmpCustomModelApi } from "./custom-model";

const TIMEOUT_MS = 15_000;
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const MAX_MODELS = 300;

export type OmpProbedModel = {
  id: string;
  name?: string;
  contextWindow?: number;
};

export type OmpCustomModelProbeInput = {
  baseUrl: string;
  api: OmpCustomModelApi;
  auth: "apiKey" | "none";
  apiKey?: string | null;
};

function buildRequest(baseUrl: string, api: OmpCustomModelApi, apiKey: string | null): { url: string; headers: Record<string, string> } {
  const url = new URL(`${baseUrl}/models`);
  const headers: Record<string, string> = { accept: "application/json" };
  if (api === "google-generative-ai") {
    if (apiKey) headers["x-goog-api-key"] = apiKey;
  } else if (api === "anthropic-messages") {
    headers["anthropic-version"] = "2023-06-01";
    if (apiKey) headers["x-api-key"] = apiKey;
  } else if (apiKey) {
    headers.authorization = `Bearer ${apiKey}`;
  }
  return { url: url.toString(), headers };
}

async function readCappedBody(response: Response): Promise<string> {
  const declared = Number(response.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) throw new Error("模型列表响应过大，已停止读取");
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_BODY_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new Error("模型列表响应过大，已停止读取");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks).toString("utf8");
}

function pickNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    const parsed = typeof value === "string" ? Number(value) : value;
    if (typeof parsed === "number" && Number.isSafeInteger(parsed) && parsed >= 1024 && parsed <= 10_000_000) return parsed;
  }
  return undefined;
}

function parseModels(text: string): OmpProbedModel[] {
  let payload: any;
  try { payload = JSON.parse(text); } catch { throw new Error("模型列表不是合法的 JSON，请检查 API 地址"); }
  const list: unknown[] = Array.isArray(payload) ? payload
    : Array.isArray(payload?.data) ? payload.data
      : Array.isArray(payload?.models) ? payload.models
        : [];
  const seen = new Map<string, OmpProbedModel>();
  for (const entry of list) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const rawId = typeof record.id === "string" ? record.id
      : typeof record.name === "string" ? record.name
        : typeof record.model === "string" ? record.model
          : "";
    const id = rawId.replace(/^models\//, "").trim();
    if (!id || id.length > 160 || seen.has(id)) continue;
    const display = typeof record.display_name === "string" ? record.display_name
      : typeof record.displayName === "string" ? record.displayName
        : undefined;
    seen.set(id, {
      id,
      ...(display && display !== id ? { name: display } : {}),
      ...(() => {
        const contextWindow = pickNumber(record.context_length, record.context_window, record.max_context_length, record.inputTokenLimit, record.contextWindow, record.maxContextTokens);
        return contextWindow ? { contextWindow } : {};
      })(),
    });
    if (seen.size >= MAX_MODELS) break;
  }
  return [...seen.values()].sort((left, right) => left.id.localeCompare(right.id));
}

/** Ask the configured endpoint for its model catalog; used by "自动获取模型". */
export async function probeOmpCustomModels(input: OmpCustomModelProbeInput): Promise<OmpProbedModel[]> {
  if (!isOmpCustomModelApi(input.api)) throw new Error("不支持的 API 兼容协议");
  const baseUrl = normalizeOmpCustomModelBaseUrl(input.baseUrl ?? "");
  const apiKey = typeof input.apiKey === "string" && input.apiKey.trim() ? input.apiKey.trim() : null;
  if (input.auth === "apiKey" && !apiKey) throw new Error("请先填写或保存 API Key，再获取模型列表");
  const { url, headers } = buildRequest(baseUrl, input.api, apiKey);
  let response: Response;
  try {
    response = await net.fetch(url, {
      method: "GET",
      headers,
      // A redirect could move the request somewhere the address rules forbid.
      redirect: "manual",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    const reason = error instanceof Error && error.name === "TimeoutError" ? "请求超时" : "无法连接该地址";
    throw new Error(`获取模型失败：${reason}。请检查 API 地址与网络、代理设置`);
  }
  if (response.status >= 300 && response.status < 400) throw new Error("接口返回了重定向，请直接填写最终的 API 地址");
  if (!response.ok) throw new Error(`获取模型失败：接口返回 HTTP ${response.status}`);
  const text = await readCappedBody(response);
  return parseModels(text);
}
