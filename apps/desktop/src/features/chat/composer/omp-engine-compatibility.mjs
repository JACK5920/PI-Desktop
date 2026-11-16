/** Return the enabled menu-item index for familiar desktop menu keys. */
export function composerEngineMenuFocusIndex(items, currentIndex, key) {
  const enabled = items.map((item, index) => item.disabled ? -1 : index).filter((index) => index >= 0);
  if (enabled.length === 0) return -1;
  if (key === "Home") return enabled[0];
  if (key === "End") return enabled.at(-1);
  if (key !== "ArrowDown" && key !== "ArrowUp") return -1;
  const current = enabled.indexOf(currentIndex);
  const step = key === "ArrowDown" ? 1 : -1;
  if (current < 0) return key === "ArrowDown" ? enabled[0] : enabled.at(-1);
  return enabled[(current + step + enabled.length) % enabled.length];
}
