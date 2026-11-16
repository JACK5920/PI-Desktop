export function createOmpManagementSession(options: {
  attach: () => Promise<unknown>;
  stop: () => Promise<unknown>;
}): {
  run<T>(operation: () => Promise<T>): Promise<T>;
};
