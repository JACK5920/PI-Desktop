export function composerEngineMenuFocusIndex(
  items: readonly { disabled: boolean }[],
  currentIndex: number,
  key: string,
): number;

export type OmpEngineIssue = "checking" | "statusUnavailable" | "unsupportedPlatform" | "notInstalled";

export function deriveOmpEngineIssue(
  engine: string,
  status: { supported?: boolean; installedVersion?: string | null } | null,
  statusLoading: boolean,
  statusFailed: boolean,
): OmpEngineIssue | null;
