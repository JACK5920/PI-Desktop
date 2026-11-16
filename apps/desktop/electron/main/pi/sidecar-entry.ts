import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export function resolvePiSidecarEntry(input: {
  dataDir?: string;
  bundledRuntimeDir: string;
  protocolVersion: number;
}): string | null {
  if (!input.dataDir) return null;
  try {
    const pointer = JSON.parse(readFileSync(join(input.dataDir, "managed-engines", "pi-runtime", "active.json"), "utf8")) as {
      version?: unknown;
    };
    if (pointer.version === "bundled") return join(input.bundledRuntimeDir, "sidecar.js");
    if (typeof pointer.version !== "string" || !/^[A-Za-z0-9._-]{1,100}$/.test(pointer.version) || pointer.version === "." || pointer.version === "..") return null;
    const directory = join(input.dataDir, "managed-engines", "pi-runtime", "versions", pointer.version);
    const manifest = JSON.parse(readFileSync(join(directory, "runtime-manifest.json"), "utf8")) as {
      schemaVersion?: unknown;
      engine?: unknown;
      protocolVersion?: unknown;
    };
    if (manifest.schemaVersion !== 1 || manifest.engine !== "pi" || manifest.protocolVersion !== input.protocolVersion) return null;
    const entry = join(directory, "sidecar.js");
    return existsSync(entry) ? entry : null;
  } catch {
    return null;
  }
}
