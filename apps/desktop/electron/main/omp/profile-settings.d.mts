export type OmpProfileSettings = {
  defaultThinkingLevel: "auto" | "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | null;
  configPath: string;
};

export function readOmpProfileSettings(profileDir: string): Promise<OmpProfileSettings>;
export function writeOmpProfileSettings(profileDir: string, input: { defaultThinkingLevel?: unknown }): Promise<OmpProfileSettings>;
export function ompProfileConfigPath(profileDir: string): string;
