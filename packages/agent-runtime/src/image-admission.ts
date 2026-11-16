/**
 * Last-view pixel admission for provider image blocks (issue #1913).
 *
 * Host Read and prompt attachments refuse an oversized image before it is
 * persisted, but older sessions, plugin and MCP tool results can still carry
 * one. A provider rejects such an image with a non-retriable 400, and every
 * later request replays it, so the session can never continue. Replacing the
 * block with a notice is deterministic for the same bytes: the request prefix
 * stays stable across turns and prompt caching keeps working.
 */
import type { Message } from "@earendil-works/pi-ai";
import { Worker } from "node:worker_threads";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  imageExceedsInlineDimensions,
  omittedImageNotice,
  probeBase64ImageDimensions,
} from "@pi-desktop/shared";

type ContentBlock = Exclude<Message["content"], string>[number];
type ImageResizeResult = {
  data: string;
  mimeType: string;
  originalWidth: number;
  originalHeight: number;
  width: number;
  height: number;
  wasResized: boolean;
};

const IMAGE_RESIZE_RESPONSE_TYPE = "pi:image-resize-response";
const MAX_MODEL_IMAGE_EDGE_PX = 2000;
const MAX_MODEL_IMAGE_BYTES = 4.5 * 1024 * 1024;
const MAX_IMAGE_RESIZE_INPUT_BYTES = 30_000_000;
const IMAGE_RESIZE_TIMEOUT_MS = 30_000;
let cachedImageResizeWorker: URL | undefined;

function admittedBlocks<T extends ContentBlock>(content: T[]): T[] {
  let next: T[] | undefined;
  content.forEach((block, index) => {
    if (block.type !== "image" || typeof block.data !== "string") return;
    const dimensions = probeBase64ImageDimensions(block.data);
    if (!imageExceedsInlineDimensions(dimensions)) return;
    next ??= content.slice();
    next[index] = { type: "text", text: omittedImageNotice(dimensions) } as T;
  });
  return next ?? content;
}

function imageResizeWorkerUrl(): URL {
  if (cachedImageResizeWorker) return cachedImageResizeWorker;

  // The managed runtime bundle places the worker beside the sidecar entry,
  // under chunks/. Source tests use the same worker shipped by pi-coding-agent.
  const runtimeEntry = process.argv[1];
  if (runtimeEntry) {
    const bundledWorker = resolve(dirname(runtimeEntry), "chunks", "image-resize-worker.js");
    if (existsSync(bundledWorker)) {
      cachedImageResizeWorker = pathToFileURL(bundledWorker);
      return cachedImageResizeWorker;
    }
  }

  const codingAgentEntry = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
  const packageWorker = resolve(dirname(codingAgentEntry), "utils", "image-resize-worker.js");
  if (!existsSync(packageWorker)) {
    throw new Error("The bundled image resize worker is unavailable");
  }
  cachedImageResizeWorker = pathToFileURL(packageWorker);
  return cachedImageResizeWorker;
}

async function resizeImage(data: string, mimeType: string): Promise<ImageResizeResult | null> {
  const inputBytes = new Uint8Array(Buffer.from(data, "base64"));
  if (inputBytes.byteLength > MAX_IMAGE_RESIZE_INPUT_BYTES) return null;
  const worker = new Worker(imageResizeWorkerUrl());
  try {
    return await new Promise<ImageResizeResult | null>((resolveResult, reject) => {
      let settled = false;
      const settle = (callback: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        callback();
      };
      const timeout = setTimeout(() => {
        settle(() => reject(new Error("Image resize worker timed out")));
      }, IMAGE_RESIZE_TIMEOUT_MS);
      timeout.unref?.();

      worker.on("message", (message: unknown) => {
        if (!message || typeof message !== "object") return;
        if (Reflect.get(message, "type") !== IMAGE_RESIZE_RESPONSE_TYPE) return;
        const error = Reflect.get(message, "error");
        if (typeof error === "string") {
          settle(() => reject(new Error(error)));
          return;
        }
        const result = Reflect.get(message, "result");
        settle(() => resolveResult(result && typeof result === "object" ? result as ImageResizeResult : null));
      });
      worker.once("error", (error) => settle(() => reject(error)));
      worker.once("exit", (code) => {
        if (!settled) settle(() => reject(new Error(`Image resize worker exited with code ${code}`)));
      });

      worker.postMessage({
        inputBytes,
        mimeType,
        options: {
          maxWidth: MAX_MODEL_IMAGE_EDGE_PX,
          maxHeight: MAX_MODEL_IMAGE_EDGE_PX,
          maxBytes: MAX_MODEL_IMAGE_BYTES,
          jpegQuality: 80,
        },
      }, [inputBytes.buffer]);
    });
  } finally {
    await worker.terminate().catch(() => undefined);
  }
}

function modelImageDimensionNote(result: ImageResizeResult): string {
  const scale = result.originalWidth / result.width;
  return `[Image resized for model input: original ${result.originalWidth}x${result.originalHeight}, sent as ${result.width}x${result.height}. Multiply coordinates by ${scale.toFixed(2)} to map them to the original image.]`;
}

function modelImageOmittedNotice(dimensions: { width: number; height: number } | undefined, encodedBytes: number): string {
  const format = (value: number) => new Intl.NumberFormat("en-US").format(value);
  const details = dimensions
    ? `${dimensions.width}x${dimensions.height}px`
    : `${format(encodedBytes)} encoded bytes`;
  return `[Image omitted for model input: resize could not bring ${details} within the ${format(MAX_MODEL_IMAGE_EDGE_PX)}px edge / ${format(MAX_MODEL_IMAGE_BYTES)}-byte limits.]`;
}

/**
 * Final provider-specific guard. The resize worker is best-effort, so a missing
 * worker, unsupported format, or input-size guard must not leak an image that
 * still exceeds the limits advertised to the model.
 */
export function omitProviderOversizedImages(messages: Message[]): Message[] {
  let nextMessages: Message[] | undefined;
  messages.forEach((message, messageIndex) => {
    if ((message.role !== "user" && message.role !== "toolResult") || !Array.isArray(message.content)) return;
    let nextContent: ContentBlock[] | undefined;
    for (let blockIndex = 0; blockIndex < message.content.length; blockIndex += 1) {
      const block = message.content[blockIndex] as ContentBlock;
      if (block.type !== "image" || typeof block.data !== "string") {
        nextContent?.push(block);
        continue;
      }
      const dimensions = probeBase64ImageDimensions(block.data);
      const tooLargeByDimensions = dimensions !== undefined && Math.max(dimensions.width, dimensions.height) > MAX_MODEL_IMAGE_EDGE_PX;
      const encodedBytes = Buffer.byteLength(block.data, "utf8");
      if (!tooLargeByDimensions && encodedBytes <= MAX_MODEL_IMAGE_BYTES) {
        nextContent?.push(block);
        continue;
      }
      nextContent ??= message.content.slice(0, blockIndex) as ContentBlock[];
      nextContent.push({
        type: "text",
        text: modelImageOmittedNotice(dimensions, encodedBytes),
      } as ContentBlock);
    }
    if (!nextContent) return;
    nextMessages ??= messages.slice();
    nextMessages[messageIndex] = { ...message, content: nextContent } as Message;
  });
  return nextMessages ?? messages;
}

/**
 * Build a model-facing copy with provider-friendly images. Persisted transcript
 * messages remain unchanged so a later model can adapt from the original bytes.
 */
export async function adaptImagesForModel(messages: Message[]): Promise<Message[]> {
  let nextMessages: Message[] | undefined;
  for (let messageIndex = 0; messageIndex < messages.length; messageIndex += 1) {
    const message = messages[messageIndex];
    if (!message || (message.role !== "user" && message.role !== "toolResult")) continue;
    if (!Array.isArray(message.content)) continue;

    let nextContent: ContentBlock[] | undefined;
    for (let blockIndex = 0; blockIndex < message.content.length; blockIndex += 1) {
      const block = message.content[blockIndex] as ContentBlock;
      if (block.type !== "image" || typeof block.data !== "string") {
        nextContent?.push(block);
        continue;
      }
      const dimensions = probeBase64ImageDimensions(block.data);
      const encodedBytes = Buffer.byteLength(block.data, "utf8");
      const needsResize =
        (dimensions !== undefined && Math.max(dimensions.width, dimensions.height) > MAX_MODEL_IMAGE_EDGE_PX) ||
        encodedBytes > MAX_MODEL_IMAGE_BYTES;
      if (!needsResize) {
        nextContent?.push(block);
        continue;
      }

      let resized: ImageResizeResult | null = null;
      try {
        resized = await resizeImage(block.data, block.mimeType || "image/png");
      } catch {
        // Resize is best-effort. The deterministic final admission below keeps
        // unsupported, corrupt, or unresizable content from poisoning replay.
      }
      if (!resized?.wasResized) {
        nextContent?.push(block);
        continue;
      }

      nextContent ??= message.content.slice(0, blockIndex) as ContentBlock[];
      nextContent.push(
        { type: "text", text: modelImageDimensionNote(resized) } as ContentBlock,
        { ...block, data: resized.data, mimeType: resized.mimeType } as ContentBlock,
      );
    }

    if (!nextContent) continue;
    nextMessages ??= messages.slice();
    nextMessages[messageIndex] = { ...message, content: nextContent } as Message;
  }
  return nextMessages ?? messages;
}

/**
 * Replace every image whose known pixel size exceeds the provider limit with
 * a text notice. Returns the input array when nothing was replaced.
 */
export function omitOversizedImages(messages: Message[]): Message[] {
  let next: Message[] | undefined;
  messages.forEach((message, index) => {
    if (message.role !== "user" && message.role !== "toolResult") return;
    if (!Array.isArray(message.content)) return;
    const content = admittedBlocks(message.content as ContentBlock[]);
    if (content === message.content) return;
    next ??= messages.slice();
    next[index] = { ...message, content } as Message;
  });
  return next ?? messages;
}
