/**
 * Preserve the selected excerpt as a readable quote in the editable follow-up
 * prompt. The fork itself carries the complete source conversation through the
 * selected assistant response; this quote makes the user's focus explicit.
 */
export function quoteSelectedText(selection: string): string {
  const excerpt = selection.trim().replace(/\r\n?/g, "\n");
  if (!excerpt) return "";
  return excerpt
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
}
