export function resolveOmpCwdFileRef(ref: string, cwd: string | null | undefined): Promise<{
  root: "scratch";
  relativePath: string;
  absolutePath: string;
  matchedBy: "exact-relative";
} | null>;
