import { useLayoutEffect, useState } from "react";
import { IPC, type ComputerCursorEvent } from "@pi-desktop/shared";
import { reduceComputerCursorEvent, type ComputerCursorState } from "./computer-cursor-state";
import "../../styles/computer-cursor.css";

export function ComputerCursor() {
  const [state, setState] = useState<ComputerCursorState | null>(null);
  useLayoutEffect(() => {
    const bridge = window.piDesktop;
    if (!bridge) return;
    const unsubscribe = bridge.on(IPC.event.computerCursor, (payload) => {
      const event = payload as ComputerCursorEvent | undefined;
      if (!event) return;
      setState((current) => reduceComputerCursorEvent(current, event));
    });
    void bridge.invoke(IPC.invoke.computerCursorReady).catch((error: unknown) => {
      console.error("Computer cursor renderer ready handshake failed", error);
    });
    return unsubscribe;
  }, []);

  if (!state) return null;
  return (
    <div className="computer-cursor-surface" aria-hidden="true">
      <div
        key={state.pulse}
        className={`computer-cursor${state.pulse ? " is-pulsing" : ""}`}
        style={{ left: state.x - state.displayBounds.x, top: state.y - state.displayBounds.y }}
      >
        <span className="computer-cursor-pointer" />
        {state.label ? <span className="computer-cursor-label">{state.label}</span> : null}
      </div>
    </div>
  );
}
