import { desktopCapturer } from "electron";
import type { ComputerRect } from "@pi-desktop/shared";

const MAX_EDGE = 1_280;

function thumbnailSize(bounds: ComputerRect): { width: number; height: number } {
  const width = Math.max(1, Math.round(bounds.width));
  const height = Math.max(1, Math.round(bounds.height));
  const scale = Math.min(1, MAX_EDGE / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

/** Match Chromium's window source to the exact native handle in the Host target id. */
export function captureSourceIdFor(sources: readonly { id: string }[], targetId: string): string | undefined {
  const nativeWindowId = targetId.split(":")[1];
  if (!nativeWindowId) return undefined;
  const prefix = `window:${nativeWindowId}:`;
  return sources.find((source) => source.id.startsWith(prefix))?.id;
}

/** Capture only the window that Host has currently bound to the grant. */
export async function captureGrantedWindow(input: {
  targetId: string;
  bounds: ComputerRect;
  log?: (message: string, data?: Record<string, unknown>) => void;
}): Promise<{ mimeType: string; base64: string } | undefined> {
  try {
    const sources = await desktopCapturer.getSources({
      types: ["window"],
      thumbnailSize: thumbnailSize(input.bounds),
      fetchWindowIcons: false,
    });
    const sourceId = captureSourceIdFor(sources, input.targetId);
    const source = sources.find((candidate) => candidate.id === sourceId);
    if (!source || source.thumbnail.isEmpty()) return undefined;
    return { mimeType: "image/png", base64: source.thumbnail.toPNG().toString("base64") };
  } catch (error) {
    input.log?.("computer use capture failed", { data: String(error) });
    return undefined;
  }
}
