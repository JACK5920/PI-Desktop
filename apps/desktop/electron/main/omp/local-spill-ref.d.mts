export function hasOmpLocalSpillScheme(value: unknown): boolean;
export function parseOmpLocalSpillRef(value: unknown): number | null;
export function getOmpLocalRootPath(input: {
  sessionFile: string;
  nativeSessionId?: string | null;
  platform?: NodeJS.Platform;
  tempDirectory?: string;
}): string | null;
export function readOmpNativeSessionId(sessionFile: string): Promise<string | null>;
export function resolveOmpLocalSpillRoot(input: {
  sessionFile: string;
  nativeSessionId?: string | null;
}): Promise<string | null>;
export function resolveOmpLocalSpillFile(input: {
  sessionFile: string;
  nativeSessionId?: string | null;
  ref: string;
}): Promise<{
  root: string;
  absolutePath: string;
  relativePath: string;
  id: number;
} | null>;
