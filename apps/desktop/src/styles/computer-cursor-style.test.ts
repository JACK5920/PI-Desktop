import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const stylesheet = readFileSync(new URL("./computer-cursor.css", import.meta.url), "utf8");

describe("computer cursor overlay surface styles", () => {
  it("keeps the monitor background transparent so underlying windows stay visible", () => {
    expect(stylesheet).toMatch(/html\[data-surface="computer-use-cursor"\][\s\S]*?background:\s*transparent\s*;/);
  });

  it("keeps the visual-only cursor overlay click-through", () => {
    expect(stylesheet).toMatch(/\.computer-cursor-surface\s*\{[^}]*pointer-events:\s*none\s*;/s);
  });

  it("limits the blue effect to the display perimeter instead of tinting the center", () => {
    expect(stylesheet).not.toMatch(/\.computer-cursor-surface::before/);
    expect(stylesheet).not.toMatch(/computer-cursor-blurred-fog/);
    expect(stylesheet).toMatch(/\.computer-cursor-surface::after\s*\{[^}]*inset 0 0 96px/i);
    expect(stylesheet).toMatch(/inset 0 0 160px 18px/i);
  });
});
