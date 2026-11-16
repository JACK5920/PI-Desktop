const MAX_WORKSPACE_FILE_BYTES = 256 * 1024;

/** Accept only a relative, non-empty file path beneath the OMP session root. */
export function normalizeOmpWorkspacePath(value) {
  if (typeof value !== "string") throw new TypeError("A relative workspace path is required");
  const path = value.trim().replace(/\\/g, "/");
  if (!path || path.length > 1024 || path.includes("\0") || path.startsWith("/") || /^[a-z]:/i.test(path)) {
    throw new Error("Only a relative workspace file path is supported");
  }
  const segments = path.split("/").filter(Boolean);
  if (!segments.length || segments.some((segment) => segment === "." || segment === "..")) {
    throw new Error("Workspace path traversal is not allowed");
  }
  return segments.join("/");
}

export function workspacePathFromOmpUri(value) {
  if (typeof value !== "string" || value.length > 2048) throw new Error("Invalid workspace URI");
  const match = /^pi-workspace:\/\/(.*)$/i.exec(value);
  if (!match) throw new Error("Unsupported OMP host URI scheme");
  const rawPath = match[1];
  if (rawPath.includes("?") || rawPath.includes("#")) throw new Error("Workspace URI query strings are not supported");
  return normalizeOmpWorkspacePath(decodeURIComponent(rawPath.replace(/^\/+/, "")));
}

/**
 * Convert a registered OMP host-tool request into one of PI Host Core's
 * existing workspace tools. The caller must still pass the request through
 * `tools.execute`; this helper only validates its shape and never accesses the
 * filesystem itself.
 */
export function normalizeOmpHostToolRequest(toolName, value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("OMP host tool arguments must be an object");
  }
  const args = value;
  const path = normalizeOmpWorkspacePath(args.path);
  if (toolName === "pi_read_workspace_file") {
    if (Object.keys(args).some((key) => !["path", "offset", "limit"].includes(key))) {
      throw new Error("Unsupported workspace read argument");
    }
    if (args.offset !== undefined && (!Number.isSafeInteger(args.offset) || args.offset < 0)) {
      throw new TypeError("Workspace read offset must be a non-negative integer");
    }
    if (args.limit !== undefined && (!Number.isSafeInteger(args.limit) || args.limit < 1 || args.limit > MAX_WORKSPACE_FILE_BYTES)) {
      throw new RangeError(`Workspace read limit must be between 1 and ${MAX_WORKSPACE_FILE_BYTES} bytes`);
    }
    return {
      toolName: "Read",
      args: {
        path,
        ...(Number.isSafeInteger(args.offset) && args.offset >= 0 ? { offset: args.offset } : {}),
        ...(Number.isSafeInteger(args.limit) && args.limit > 0 ? { limit: args.limit } : {}),
      },
    };
  }
  if (toolName === "pi_write_workspace_file") {
    if (Object.keys(args).some((key) => !["path", "content"].includes(key))) {
      throw new Error("Unsupported workspace write argument");
    }
    if (typeof args.content !== "string") throw new TypeError("Workspace write content must be text");
    if (Buffer.byteLength(args.content, "utf8") > MAX_WORKSPACE_FILE_BYTES) {
      throw new Error(`Workspace write exceeds ${MAX_WORKSPACE_FILE_BYTES} bytes`);
    }
    return { toolName: "Write", args: { path, content: args.content } };
  }
  if (toolName === "pi_edit_workspace_file") {
    if (Object.keys(args).some((key) => !["path", "oldText", "newText"].includes(key))) {
      throw new Error("Unsupported workspace edit argument");
    }
    if (typeof args.oldText !== "string" || typeof args.newText !== "string") {
      throw new TypeError("Workspace edit requires oldText and newText");
    }
    if (Buffer.byteLength(args.oldText, "utf8") + Buffer.byteLength(args.newText, "utf8") > MAX_WORKSPACE_FILE_BYTES) {
      throw new Error(`Workspace edit exceeds ${MAX_WORKSPACE_FILE_BYTES} bytes`);
    }
    return { toolName: "Edit", args: { path, oldText: args.oldText, newText: args.newText } };
  }
  throw new Error("Unknown OMP host tool");
}

export const OMP_WORKSPACE_FILE_LIMIT = MAX_WORKSPACE_FILE_BYTES;
