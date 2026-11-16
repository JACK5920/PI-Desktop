import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  AgentSidecar as RuntimeAgentSidecar,
  type StderrHandler,
} from "@pi-desktop/host-runtime";
import { PROTOCOL_VERSION } from "@pi-desktop/shared";
import { redactValue } from "./logger";
import { getModuleDirectory } from "./module-path";
import { resolvePiSidecarEntry } from "./pi/sidecar-entry";

export type {
  LocalToolHandler,
  LocalToolResult,
  ProjectInstructionResolver,
  SidecarNotificationHandler,
  TrustedExtensionSidecarBridge,
  VendorAuthResolver,
} from "@pi-desktop/host-runtime";

let pinnedSidecarEntry: string | undefined;

function resolveSidecarEntry(): string {
  if (pinnedSidecarEntry) return pinnedSidecarEntry;
  const candidates = [
    join(process.resourcesPath || "", "agent-runtime/sidecar.js"),
    join(
      getModuleDirectory(import.meta.url),
      "../../../../packages/agent-runtime/dist-bundle/sidecar.js",
    ),
    join(
      getModuleDirectory(import.meta.url),
      "../../../agent-runtime/dist/sidecar.js",
    ),
    join(
      getModuleDirectory(import.meta.url),
      "../../../../packages/agent-runtime/dist/sidecar.js",
    ),
  ];
  const bundledEntry = candidates.find((candidate) => candidate && existsSync(candidate)) ?? candidates[candidates.length - 1]!;
  const managedEntry = resolvePiSidecarEntry({
    dataDir: process.env.PI_DESKTOP_DATA_DIR,
    bundledRuntimeDir: join(bundledEntry, ".."),
    protocolVersion: PROTOCOL_VERSION,
  });
  pinnedSidecarEntry = managedEntry ?? bundledEntry;
  return pinnedSidecarEntry;
}

function fallbackStderrLogger(text: string): void {
  console.error(
    `[agent/runtime] ${JSON.stringify({
      ts: new Date().toISOString(),
      level: "info",
      channel: "agent",
      category: "runtime",
      event: "child.process.stderr",
      message: "child process stderr",
      data: { output: redactValue(text.trimEnd()) },
    })}`,
  );
}

/**
 * The desktop's agent sidecar: the shared stdio transport from
 * `@pi-desktop/host-runtime`, launched the only way Electron can run Node
 * code out of process — its own executable with `ELECTRON_RUN_AS_NODE` — on
 * the sidecar bundle this build ships.
 */
export class AgentSidecar extends RuntimeAgentSidecar {
  constructor(onStderr?: StderrHandler) {
    super({
      launch: {
        command: process.execPath,
        // Keep the OS trust store available to the sidecar. On macOS the
        // Electron 43 build applies `--use-system-ca` by replacing the
        // bundled roots instead of adding them (its keychain enumeration
        // misses public anchors like GlobalSign Root CA - R3, issue #1187),
        // so there the sidecar merges bundled + system + extra CAs itself
        // (agent-runtime system-ca) and this launcher omits the flag. On
        // Windows and Linux the flag behaves as documented and stays.
        // Never bypass TLS verification.
        args: [
          "--max-old-space-size=2048",
          ...(process.platform === "darwin" ? [] : ["--use-system-ca"]),
          resolveSidecarEntry(),
        ],
        env: {
          ...process.env,
          ELECTRON_RUN_AS_NODE: "1",
        },
      },
      onStderr: onStderr ?? fallbackStderrLogger,
    });
  }
}
