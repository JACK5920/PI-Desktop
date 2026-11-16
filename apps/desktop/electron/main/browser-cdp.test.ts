import { describe, expect, it, vi } from "vitest";
import type { WebContents } from "electron";
import { BrowserCdp } from "./browser-cdp.js";

describe("BrowserCdp console collection", () => {
  it("uses Console.messageAdded once and preserves repeated identical log lines", async () => {
    let listener:
      | ((event: unknown, method: string, params: unknown) => void)
      | undefined;
    const wc = {
      id: 7,
      isDestroyed: () => false,
      getURL: () => "https://example.test/",
      getTitle: () => "Example",
      debugger: {
        isAttached: () => true,
        attach: vi.fn(),
        detach: vi.fn(),
        on: vi.fn((_name: string, next: typeof listener) => {
          listener = next;
        }),
        off: vi.fn(),
        sendCommand: vi.fn(async () => ({})),
      },
    } as unknown as WebContents;

    const cdp = new BrowserCdp();
    await cdp.attach(wc);
    expect(listener).toBeDefined();

    listener?.({}, "Runtime.consoleAPICalled", {
      type: "log",
      args: [{ type: "string", value: "same line" }],
    });
    listener?.({}, "Console.messageAdded", {
      message: { level: "log", text: "same line" },
    });
    listener?.({}, "Runtime.consoleAPICalled", {
      type: "log",
      args: [{ type: "string", value: "same line" }],
    });
    listener?.({}, "Console.messageAdded", {
      message: { level: "log", text: "same line" },
    });

    expect(cdp.console()).toHaveLength(2);
    expect(cdp.console().map((message) => message.text)).toEqual(["same line", "same line"]);
  });
});
