import { useEffect, useState } from "react";
import { IPC, type ComputerCursorEvent } from "@pi-desktop/shared";
import { reduceComputerCursorEvent, type ComputerCursorState } from "./computer-cursor-state";
import "../../styles/computer-cursor.css";

export function ComputerCursor() {
  const [state, setState] = useState<ComputerCursorState | null>(null);
  useEffect(() => {
    const unsubscribe = window.piDesktop?.on(IPC.event.computerCursor, (payload) => {
      const event = payload as ComputerCursorEvent | undefined;
      if (!event) return;
      setState((current) => reduceComputerCursorEvent(current, event));
    });
    return unsubscribe;
  }, []);

  if (!state) return null;
  return (
    <div className="computer-cursor-surface" aria-hidden="true">
      <div
        key={state.pulse}
        className={`computer-cursor${state.pulse ? " is-pulsing" : ""}`}
        style={{ left: state.x - state.bounds.x + 48, top: state.y - state.bounds.y + 48 }}
      >
        <span className="computer-cursor-pointer" />
        {state.label ? <span className="computer-cursor-label">{state.label}</span> : null}
      </div>
    </div>
  );
}
