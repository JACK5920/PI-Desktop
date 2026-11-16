const MAX_STATUS_ITEMS = 20;
const MAX_STATUS_CHARS = 2_000;
const MAX_WIDGET_ITEMS = 12;
const MAX_WIDGET_LINES = 12;
const MAX_WIDGET_LINE_CHARS = 2_000;
const MAX_WIDGET_CHARS = 16_000;
const MAX_EDITOR_TEXT_CHARS = 64_000;

export function ompSelectOptionKind(request, index) {
  const optionCount = Array.isArray(request?.options) ? request.options.length : 0;
  if (!Number.isInteger(index) || index < 0 || index >= optionCount) return null;
  const marker = request.selectionMarker;
  if (marker !== "radio" && marker !== "checkbox") return "radio";
  const markableCount = Number.isInteger(request.markableCount)
    ? Math.max(0, Math.min(optionCount, request.markableCount))
    : optionCount;
  return index < markableCount ? marker : "action";
}

export function ompExtensionRequestNeedsResponse(method) {
  return ["select", "confirm", "input", "editor", "ask"].includes(method);
}

function cleanKey(value, fallback) {
  return typeof value === "string" && value.trim() && value.length <= 128 ? value.trim() : fallback;
}

export function updateOmpStatusMap(current, keyValue, value) {
  const key = cleanKey(keyValue, "default");
  const next = { ...current };
  if (typeof value !== "string" || !value.trim()) {
    delete next[key];
    return next;
  }
  next[key] = value.slice(0, MAX_STATUS_CHARS);
  const keys = Object.keys(next);
  while (keys.length > MAX_STATUS_ITEMS) delete next[keys.shift()];
  return next;
}

export function updateOmpWidgetMap(current, keyValue, linesValue, placementValue) {
  const key = cleanKey(keyValue, "default");
  const next = { ...current };
  if (!Array.isArray(linesValue)) {
    delete next[key];
    return next;
  }
  let remaining = MAX_WIDGET_CHARS;
  const lines = [];
  for (const raw of linesValue.slice(0, MAX_WIDGET_LINES)) {
    if (typeof raw !== "string" || remaining <= 0) continue;
    const line = raw.slice(0, Math.min(MAX_WIDGET_LINE_CHARS, remaining));
    if (!line) continue;
    lines.push(line);
    remaining -= line.length;
  }
  if (lines.length) {
    next[key] = {
      key,
      lines,
      placement: placementValue === "belowEditor" ? "belowEditor" : "aboveEditor",
    };
  } else {
    delete next[key];
  }
  const keys = Object.keys(next);
  while (keys.length > MAX_WIDGET_ITEMS) delete next[keys.shift()];
  return next;
}

export function normalizeOmpEditorText(value) {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_EDITOR_TEXT_CHARS
    ? value
    : null;
}
