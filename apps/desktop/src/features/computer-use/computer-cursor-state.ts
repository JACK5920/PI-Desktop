import type { ComputerCursorEvent, ComputerRect } from "@pi-desktop/shared";

export type ComputerCursorState = {
  grantId: string;
  bounds: ComputerRect;
  x: number;
  y: number;
  label?: string;
  pulse: number;
};

export function reduceComputerCursorEvent(
  current: ComputerCursorState | null,
  event: ComputerCursorEvent,
): ComputerCursorState | null {
  if (event.kind === "hide") return current?.grantId === event.grantId ? null : current;
  if (event.kind === "show") return {
    grantId: event.grantId,
    bounds: event.bounds,
    x: event.bounds.x + event.bounds.width / 2,
    y: event.bounds.y + event.bounds.height / 2,
    pulse: current?.pulse ?? 0,
  };
  if (!current || current.grantId !== event.grantId) return current;
  if (event.kind === "move") return { ...current, x: event.x, y: event.y, label: event.label };
  return { ...current, x: event.x, y: event.y, pulse: current.pulse + 1 };
}
