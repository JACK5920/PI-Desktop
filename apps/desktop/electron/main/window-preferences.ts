/**
 * Small JSON preference files the main process keeps in the data directory:
 * normal and compact window geometry plus the persisted close behavior.
 * Geometry and close preferences are best-effort; missing or malformed files
 * read as "unset".
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { CloseBehavior } from "@pi-desktop/shared";

export type WindowState = { x: number; y: number; width: number; height: number };
export type WindowSize = { width: number; height: number };

function windowStatePath(dataDir: string) {
  return join(dataDir, "window-state.json");
}

function miniWindowStatePath(dataDir: string) {
  return join(dataDir, "mini-window-state.json");
}

export async function readWindowState(
  dataDir: string,
  minWidth: number,
  minHeight: number,
): Promise<WindowState | null> {
  try {
    const raw = JSON.parse(await readFile(windowStatePath(dataDir), "utf8"));
    const s = {
      x: Number(raw.x),
      y: Number(raw.y),
      width: Number(raw.width),
      height: Number(raw.height),
    };
    if (![s.x, s.y, s.width, s.height].every(Number.isFinite)) return null;
    if (s.width < minWidth || s.height < minHeight) return null;
    return s;
  } catch {
    return null;
  }
}

export function writeWindowState(dataDir: string, state: WindowState) {
  try {
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(windowStatePath(dataDir), JSON.stringify(state), "utf8");
  } catch {
    // best-effort persistence
  }
}

export function readMiniWindowSize(
  dataDir: string,
  minWidth: number,
  minHeight: number,
): WindowSize | null {
  try {
    const raw: unknown = JSON.parse(readFileSync(miniWindowStatePath(dataDir), "utf8"));
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
    const value = raw as Record<string, unknown>;
    if (value.version !== 1) return null;
    if (typeof value.width !== "number" || typeof value.height !== "number") return null;
    if (!Number.isFinite(value.width) || !Number.isFinite(value.height)) return null;
    const size = { width: Math.round(value.width), height: Math.round(value.height) };
    if (size.width < minWidth || size.height < minHeight) return null;
    return size;
  } catch {
    return null;
  }
}

export function writeMiniWindowSize(dataDir: string, size: WindowSize) {
  const width = Math.round(size.width);
  const height = Math.round(size.height);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1) return;
  try {
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(
      miniWindowStatePath(dataDir),
      JSON.stringify({ version: 1, width, height }),
      "utf8",
    );
  } catch {
    // best-effort persistence
  }
}

function closeBehaviorPath(dataDir: string) {
  return join(dataDir, "close-behavior.json");
}

export function readCloseBehavior(dataDir: string): CloseBehavior | null {
  try {
    const raw = JSON.parse(readFileSync(closeBehaviorPath(dataDir), "utf8"));
    return raw === "ask" || raw === "tray" || raw === "quit" ? raw : null;
  } catch {
    return null;
  }
}

export function writeCloseBehavior(dataDir: string, behavior: CloseBehavior) {
  try {
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(closeBehaviorPath(dataDir), JSON.stringify(behavior), "utf8");
  } catch {
    // best-effort persistence
  }
}
