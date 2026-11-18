import type { WindowBounds } from "./work-panel-window";

export type MiniWindowRestoreState = {
  bounds: WindowBounds;
  wasMaximized: boolean;
};

export const MINI_WINDOW_DEFAULT_SIZE = { width: 440, height: 640 } as const;
export const MINI_WINDOW_MINIMUM_SIZE = { width: 320, height: 400 } as const;
const miniWindowStates = new WeakMap<object, MiniWindowRestoreState>();

export function calculateMiniWindowBounds(
  workArea: WindowBounds,
  target: { width: number; height: number } = MINI_WINDOW_DEFAULT_SIZE,
): WindowBounds {
  const width = Math.max(1, Math.min(Math.floor(target.width), workArea.width));
  const height = Math.max(1, Math.min(Math.floor(target.height), workArea.height));
  return {
    x: Math.round(workArea.x + (workArea.width - width) / 2),
    y: Math.round(workArea.y + (workArea.height - height) / 2),
    width,
    height,
  };
}

export function miniWindowMinimumSize(workArea: Pick<WindowBounds, "width" | "height">) {
  return {
    width: Math.max(1, Math.min(MINI_WINDOW_MINIMUM_SIZE.width, workArea.width)),
    height: Math.max(1, Math.min(MINI_WINDOW_MINIMUM_SIZE.height, workArea.height)),
  };
}

export function beginMiniWindowMode(
  window: object,
  restoreState: MiniWindowRestoreState,
): boolean {
  if (miniWindowStates.has(window)) return false;
  miniWindowStates.set(window, {
    bounds: { ...restoreState.bounds },
    wasMaximized: restoreState.wasMaximized,
  });
  return true;
}

export function miniWindowRestoreState(window: object): MiniWindowRestoreState | null {
  const state = miniWindowStates.get(window);
  return state
    ? { bounds: { ...state.bounds }, wasMaximized: state.wasMaximized }
    : null;
}

export function endMiniWindowMode(window: object): MiniWindowRestoreState | null {
  const state = miniWindowRestoreState(window);
  if (state) miniWindowStates.delete(window);
  return state;
}

export function isMiniWindowMode(window: object): boolean {
  return miniWindowStates.has(window);
}
