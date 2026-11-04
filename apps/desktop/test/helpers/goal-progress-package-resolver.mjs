/** Resolve workspace packages changed by this task from this worktree's builds. */
const sharedPackage = new URL(
  "../../../../packages/shared/dist/index.js",
  import.meta.url,
);

export function resolve(specifier, context, nextResolve) {
  if (specifier === "@pi-desktop/shared") {
    return { url: sharedPackage.href, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
