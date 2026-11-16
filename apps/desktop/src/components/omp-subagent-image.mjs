const MAX_CHARS = 14 * 1024 * 1024;
const ALLOWED_MIMES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

/** Build a bounded raster data URL from an OMP-native image content block. */
export function ompSubagentImageSource(part) {
  const mimeType = typeof part?.mimeType === "string" ? part.mimeType.toLowerCase() : "";
  const data = typeof part?.data === "string" ? part.data : "";
  if (!ALLOWED_MIMES.has(mimeType) || data.length === 0 || data.length > MAX_CHARS) return null;
  if (data.startsWith("data:")) {
    const match = /^data:(image\/(?:png|jpeg|gif|webp));base64,([a-z0-9+/]+=*)$/i.exec(data);
    return match && match[1].toLowerCase() === mimeType ? data : null;
  }
  return /^[a-z0-9+/]+=*$/i.test(data) ? `data:${mimeType};base64,${data}` : null;
}
