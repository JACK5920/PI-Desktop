export type OmpStatusMap = Record<string, string>;
export type OmpWidget = {
  key: string;
  lines: string[];
  placement: "aboveEditor" | "belowEditor";
};
export type OmpWidgetMap = Record<string, OmpWidget>;

export type OmpSelectOptionKind = "radio" | "checkbox" | "action" | null;

export function ompSelectOptionKind(
  request: { options?: unknown; selectionMarker?: unknown; markableCount?: unknown },
  index: number,
): OmpSelectOptionKind;

export function ompExtensionRequestNeedsResponse(method: unknown): boolean;

export function updateOmpStatusMap(
  current: OmpStatusMap,
  key: unknown,
  value: unknown,
): OmpStatusMap;

export function updateOmpWidgetMap(
  current: OmpWidgetMap,
  key: unknown,
  lines: unknown,
  placement: unknown,
): OmpWidgetMap;

export function normalizeOmpEditorText(value: unknown): string | null;
