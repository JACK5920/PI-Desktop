import type { Message } from "@earendil-works/pi-ai";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { UiMessage } from "@pi-desktop/shared";
import { probeBase64ImageDimensions } from "@pi-desktop/shared";
import { deflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { omitOversizedImages, omitProviderOversizedImages } from "./image-admission.js";
import { convertToLlm, convertToLlmForProvider } from "./pi-runtime-messages.js";
import { toolResultFromUi } from "./runtime.js";

function pngBase64(width: number, height: number): string {
  const bytes = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]).copy(bytes);
  bytes.write("IHDR", 12, "latin1");
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes.toString("base64");
}

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(name: string, data: Buffer): Buffer {
  const type = Buffer.from(name, "ascii");
  const crcInput = Buffer.concat([type, data]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(crcInput));
  return Buffer.concat([length, crcInput, checksum]);
}

function validPngBase64(width: number, height: number): string {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  const rowLength = width * 4 + 1;
  const pixels = Buffer.alloc(rowLength * height, 0xff);
  for (let row = 0; row < height; row += 1) pixels[row * rowLength] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(pixels)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]).toString("base64");
}

const TALL = pngBase64(780, 14182);
const NORMAL = pngBase64(1688, 1514);
const NOTICE =
  "[Image omitted: 780x14182 px exceeds the 8000 px longest-edge limit for model input.]";

describe("omitOversizedImages", () => {
  it("replaces an oversized image in a user prompt and keeps its position", () => {
    const messages: Message[] = [{
      role: "user",
      content: [
        { type: "text", text: "before" },
        { type: "image", data: TALL, mimeType: "image/png" },
        { type: "image", data: NORMAL, mimeType: "image/png" },
      ],
      timestamp: 1,
    }];
    const [user] = omitOversizedImages(messages);
    expect(user?.content).toEqual([
      { type: "text", text: "before" },
      { type: "text", text: NOTICE },
      { type: "image", data: NORMAL, mimeType: "image/png" },
    ]);
    expect(messages[0]?.content).toHaveLength(3);
    expect((messages[0]?.content as Array<{ type: string }>)[1]?.type).toBe("image");
  });

  it("returns the same array when every image is admissible", () => {
    const messages: Message[] = [
      { role: "user", content: "plain text", timestamp: 1 },
      {
        role: "user",
        content: [
          { type: "image", data: NORMAL, mimeType: "image/png" },
          { type: "image", data: "not-an-image", mimeType: "image/png" },
        ],
        timestamp: 2,
      },
    ];
    expect(omitOversizedImages(messages)).toBe(messages);
  });

  it("heals a restored session whose Read result holds an oversized image", () => {
    const row = {
      id: "tool-1",
      role: "tool",
      content: "",
      toolName: "read",
      toolCallId: "call-1",
      toolStatus: "done",
      toolResult: {
        path: "page.png",
        text: "Image file page.png (1890000 bytes, image/png); the image is attached to this result.",
        images: [{ data: TALL, mimeType: "image/png" }],
      },
    } as unknown as UiMessage;
    const restored = toolResultFromUi(row, 1);
    expect(restored.content.some((block) => block.type === "image")).toBe(true);

    const [outgoing] = convertToLlm([restored]);
    expect(outgoing?.role).toBe("toolResult");
    const content = outgoing?.content as Array<{ type: string; text?: string }>;
    expect(content.some((block) => block.type === "image")).toBe(false);
    expect(content.at(-1)).toEqual({ type: "text", text: NOTICE });
  });
});

describe("omitProviderOversizedImages", () => {
  it("does not pass an image beyond provider limits when resizing is unavailable", () => {
    const tooWide = validPngBase64(2400, 24);
    const tooManyBytes = "A".repeat(4_718_593);
    const messages: Message[] = [{
      role: "user",
      content: [
        { type: "text", text: "inspect these" },
        { type: "image", data: tooWide, mimeType: "image/png" },
        { type: "image", data: tooManyBytes, mimeType: "image/png" },
      ],
      timestamp: 1,
    }];

    const [projected] = omitProviderOversizedImages(messages);
    const projectedContent = projected?.content as Array<{ type: string; text?: string }>;
    expect(projectedContent[0]).toEqual({ type: "text", text: "inspect these" });
    expect(projectedContent[1]?.text).toContain("2400x24px");
    expect(projectedContent[2]?.text).toContain("4,718,593 encoded bytes");
    expect(projectedContent.some((block) => block.type === "image")).toBe(false);
    expect((messages[0]?.content as Array<{ type: string }>).filter((block) => block.type === "image")).toHaveLength(2);
  });
});

describe("convertToLlmForProvider image adaptation", () => {
  it("resizes model-facing images and leaves the original transcript untouched", async () => {
    const originalData = validPngBase64(2400, 24);
    const source = {
      role: "user",
      content: [
        { type: "text", text: "inspect the screenshot" },
        { type: "image", data: originalData, mimeType: "image/png" },
      ],
      timestamp: 1,
    } satisfies Message;
    const originalMessages = [source as unknown as AgentMessage];

    const [providerMessage] = await convertToLlmForProvider(originalMessages);
    const providerContent = providerMessage?.content as Array<{
      type: string;
      text?: string;
      data?: string;
      mimeType?: string;
    }>;

    expect(providerContent[1]?.type).toBe("text");
    expect(providerContent[1]?.text).toMatch(/2400x24.*2000x20/);
    expect(providerContent[1]?.text).toMatch(/coordinates by 1\.20/);
    expect(providerContent[2]?.type).toBe("image");
    expect(probeBase64ImageDimensions(providerContent[2]?.data ?? "")).toEqual({
      width: 2000,
      height: 20,
    });
    expect(providerContent[2]?.mimeType).toBe("image/png");
    expect(source.content[1]).toEqual({
      type: "image",
      data: originalData,
      mimeType: "image/png",
    });
    expect(convertToLlm(originalMessages)[0]?.content).toEqual(source.content);
  });
});
