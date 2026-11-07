import { describe, expect, it } from "vitest";
import { decodeImageBase64 } from "./openai-images.js";

describe("decodeImageBase64", () => {
  it("decodes a multi-megabyte base64 payload without overflowing the stack", () => {
    const bytes = Buffer.alloc(6 * 1024 * 1024, 0x5a);
    const encoded = bytes.toString("base64");

    expect(encoded.length).toBeGreaterThan(8_000_000);
    expect(Buffer.from(decodeImageBase64(encoded)).equals(bytes)).toBe(true);
  });

  it.each(["QUJD", "QUJDRA==", "QUJDREU="])("accepts valid base64 %s", (value) => {
    expect(Buffer.from(decodeImageBase64(value))).toEqual(Buffer.from(value, "base64"));
  });

  it.each(["", "QQ", "QUI", "QUJD!A==", "QU=DRA==", "QUJ===", "Q===", "QUJDR", "QUJD RA==", "QUJD-A==", "===="])(
    "rejects malformed base64 %s",
    (value) => expect(() => decodeImageBase64(value)).toThrow(),
  );
});
