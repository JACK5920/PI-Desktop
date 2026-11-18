export type OmpWorktreeExitPolicy = "keep" | "ask" | "remove" | "force";

export type OmpProfileSettings = {
  defaultThinkingLevel: "auto" | "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | null;
  worktreeOnExit: OmpWorktreeExitPolicy | null;
  configPath: string;
};

export function readOmpProfileSettings(profileDir: string): Promise<OmpProfileSettings>;
export function writeOmpProfileSettings(profileDir: string, input: { defaultThinkingLevel?: unknown; worktreeOnExit?: unknown }): Promise<OmpProfileSettings>;
export function ompProfileConfigPath(profileDir: string): string;
