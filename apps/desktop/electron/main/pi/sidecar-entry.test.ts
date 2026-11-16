import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolvePiSidecarEntry } from "./sidecar-entry";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

describe("resolvePiSidecarEntry", () => {
  it("uses the bundled runtime when no managed runtime has been selected", async () => {
    const root = await mkdtemp(join(tmpdir(), `pi-entry-${randomUUID()}-`)); roots.push(root);
    const bundle = join(root, "bundle");
    await mkdir(bundle);
    await writeFile(join(bundle, "sidecar.js"), "// built in");
    expect(resolvePiSidecarEntry({ dataDir: root, bundledRuntimeDir: bundle, protocolVersion: 11 })).toBeNull();
    const versionDir = join(root, "managed-engines", "pi-runtime", "versions", "selected");
    await mkdir(versionDir, { recursive: true });
    await writeFile(join(versionDir, "sidecar.js"), "// updated");
    await writeFile(join(versionDir, "runtime-manifest.json"), JSON.stringify({ schemaVersion: 1, engine: "pi", protocolVersion: 11 }));
    await mkdir(join(root, "managed-engines", "pi-runtime"), { recursive: true });
    await writeFile(join(root, "managed-engines", "pi-runtime", "active.json"), JSON.stringify({ version: "selected" }));
    expect(resolvePiSidecarEntry({ dataDir: root, bundledRuntimeDir: bundle, protocolVersion: 11 })).toBe(join(versionDir, "sidecar.js"));
  });

  it("falls back when the selected runtime is missing or protocol-incompatible", async () => {
    const root = await mkdtemp(join(tmpdir(), `pi-entry-${randomUUID()}-`)); roots.push(root);
    const bundle = join(root, "bundle");
    await mkdir(bundle); await writeFile(join(bundle, "sidecar.js"), "// built in");
    const managed = join(root, "managed-engines", "pi-runtime");
    await mkdir(managed, { recursive: true });
    await writeFile(join(managed, "active.json"), JSON.stringify({ version: "../outside" }));
    expect(resolvePiSidecarEntry({ dataDir: root, bundledRuntimeDir: bundle, protocolVersion: 11 })).toBeNull();
    const incompatible = join(managed, "versions", "old"); await mkdir(incompatible, { recursive: true });
    await writeFile(join(incompatible, "sidecar.js"), "// wrong protocol");
    await writeFile(join(incompatible, "runtime-manifest.json"), JSON.stringify({ schemaVersion: 1, engine: "pi", protocolVersion: 10 }));
    await writeFile(join(managed, "active.json"), JSON.stringify({ version: "old" }));
    expect(resolvePiSidecarEntry({ dataDir: root, bundledRuntimeDir: bundle, protocolVersion: 11 })).toBeNull();
  });

  it("can explicitly select the bundled runtime for a rollback", async () => {
    const root = await mkdtemp(join(tmpdir(), `pi-entry-${randomUUID()}-`)); roots.push(root);
    const bundle = join(root, "bundle"); await mkdir(bundle); await writeFile(join(bundle, "sidecar.js"), "// built in");
    const managed = join(root, "managed-engines", "pi-runtime"); await mkdir(managed, { recursive: true });
    await writeFile(join(managed, "active.json"), JSON.stringify({ version: "bundled" }));
    expect(resolvePiSidecarEntry({ dataDir: root, bundledRuntimeDir: bundle, protocolVersion: 11 })).toBe(join(bundle, "sidecar.js"));
  });
});
