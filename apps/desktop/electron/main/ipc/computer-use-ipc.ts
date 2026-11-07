import { IPC } from "@pi-desktop/shared";
import type { ComputerGrantView } from "@pi-desktop/shared";
import type { ComputerUseWidget } from "../computer-use/widget-window";
import { getActiveComputerUseRun } from "../computer-use/active-run";
import { matchesActiveComputerUseRun } from "../computer-use/stop-policy";
import type { HostProcess } from "../host-process";
import type { IpcRegistrar } from "./types";

function parseStopRequest(raw: unknown): { sessionId: string; grantId: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Invalid Computer Use stop request");
  const value = raw as Record<string, unknown>;
  if (Object.keys(value).some((key) => !["sessionId", "grantId"].includes(key))) throw new Error("Invalid Computer Use stop request");
  if (typeof value.sessionId !== "string" || !value.sessionId.trim() || value.sessionId.length > 256) throw new Error("Invalid Computer Use session");
  if (typeof value.grantId !== "string" || !value.grantId.trim() || value.grantId.length > 256) throw new Error("Invalid Computer Use grant");
  return { sessionId: value.sessionId, grantId: value.grantId };
}

export function registerComputerUseIpc(input: {
  registrar: IpcRegistrar;
  getHost: () => HostProcess | null;
  abortAgentRun: (sessionId: string) => Promise<void>;
  widget?: Pick<ComputerUseWidget, "owns">;
}): void {
  const { registrar, getHost, abortAgentRun, widget } = input;
  const assertOwner = (event: Parameters<IpcRegistrar["assertMainWindowSender"]>[0]): void => {
    if (widget?.owns(event.sender.id)) return;
    registrar.assertMainWindowSender(event);
  };

  registrar.handleWithEvent(IPC.invoke.computerCapabilities, async (event) => {
    registrar.assertMainWindowSender(event);
    const host = getHost();
    if (!host) throw new Error("host unavailable");
    return host.call("computer.capabilities");
  });

  registrar.handleWithEvent(IPC.invoke.computerGrantDescribe, async (event) => {
    assertOwner(event);
    const host = getHost();
    if (!host) throw new Error("host unavailable");
    return host.call<{ grant: ComputerGrantView | null }>("computer.grantDescribe");
  });

  registrar.handleWithEvent(IPC.invoke.computerGrantRevoke, async (event, raw: unknown) => {
    assertOwner(event);
    const request = parseStopRequest(raw);
    const active = getActiveComputerUseRun();
    if (!active) return { revoked: false, requested: false };
    if (!matchesActiveComputerUseRun({ sessionId: active.sessionId, grantId: active.grant.grantId }, request)) {
      return { revoked: false, requested: false };
    }
    const host = getHost();
    if (!host) throw new Error("host unavailable");
    // Revoke first so no additional native action can be accepted while the
    // owning Agent turn is being cancelled.
    await host.call("computer.grantRevoke", { reason: "user" });
    await abortAgentRun(active.sessionId);
    return { revoked: true, requested: true };
  });
}
