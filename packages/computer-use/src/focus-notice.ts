import type { ComputerAction, ComputerInspection } from "@pi-desktop/shared";

/**
 * Actions whose payload reaches the application as keystrokes.
 *
 * `set_value` is deliberately absent: it writes through the accessibility value
 * pattern and never needs keyboard focus. That is precisely why a `set_value`
 * followed by `press_keys` can leave the named field unfocused.
 */
const KEYBOARD_DELIVERED_ACTIONS: ReadonlySet<ComputerAction["kind"]> = new Set([
  "type_text",
  "press_keys",
]);

/**
 * Warn when a keystroke action names an element that did not hold keyboard focus
 * in the observation the action was bound to.
 *
 * Why: host-core hands the element token to the driver and reports
 * `dispatched: "system-input"` as soon as the driver accepts the call. Whether
 * the driver focuses that element first is the driver's own decision. Measured
 * on a Chromium composer: `press_keys` Enter after `set_value` was accepted,
 * delivered nothing to the named field, and still reported success -- so the
 * model read a clean dispatch as a delivered keystroke and concluded the message
 * had been sent. A silent no-op wearing a success label is worse than a refusal,
 * because nothing tells the model to look again.
 *
 * This is a diagnostic, not a verdict. The driver may focus the element itself
 * (`type_text`'s foreground path calls UIA SetFocus), so the notice says the
 * element may be unchanged and names the two ways to settle it. No gate is
 * relaxed, no action is refused, and focus/foreground behaviour is untouched.
 */
export function keystrokeFocusNotice(
  action: ComputerAction,
  inspection: ComputerInspection,
): string | undefined {
  if (!action.uid) return undefined;
  if (!KEYBOARD_DELIVERED_ACTIONS.has(action.kind)) return undefined;
  const node = inspection.nodes.find((candidate) => candidate.uid === action.uid);
  // An unknown uid is already refused by validateAnswerAction. Stay silent
  // rather than invent a second, weaker reason for the same rejection.
  if (!node || node.focused !== false) return undefined;
  return "keystrokes reach the focused element: the named element was not focused before this action, so it may be unchanged. Click it first, or confirm the effect in the next observation.";
}
