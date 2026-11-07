export type ComputerUseStopIdentity = {
  sessionId: string;
  grantId: string;
};

/** A Stop request may affect only the exact live grant/session pair shown to the user. */
export function matchesActiveComputerUseRun(
  active: ComputerUseStopIdentity | null,
  request: ComputerUseStopIdentity,
): boolean {
  return active !== null
    && active.sessionId === request.sessionId
    && active.grantId === request.grantId;
}
