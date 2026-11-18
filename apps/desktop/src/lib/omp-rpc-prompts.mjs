export function isAuthorizationCodePrompt(request) {
  if (!request || typeof request !== "object" || Array.isArray(request)) return false;
  const source = request;
  const copy = [source.title, source.message, source.placeholder, source.instructions]
    .filter((part) => typeof part === "string")
    .join(" ")
    .toLocaleLowerCase();
  return /authorization\s+code|auth\s+code|redirect\s+url|callback\s+url|授权码|回跳地址|登录验证码/i.test(copy);
}

/**
 * OMP 18.22.1 sends this provider warning through RPC as a plain input request.
 * It cannot carry the SDK-only riskAcknowledgement flag, so use the upstream
 * wire fingerprint (a risk warning with the literal "yes" placeholder) and
 * require the dedicated provider-management session before treating it as an
 * acceptance dialog.
 */
export function isOmpPreAuthRiskAcknowledgementPrompt(request, context) {
  const warningText = request && typeof request === "object" && !Array.isArray(request)
    ? [request.title, request.message, request.instructions]
      .filter((part) => typeof part === "string")
      .join(" ")
      .toLocaleLowerCase()
    : "";
  const asksRiskAcceptance = /at your own risk|risk.{0,40}(?:accept|continue)|(?:accept|continue).{0,40}risk|风险自负|风险.{0,12}(?:接受|继续)/i.test(warningText);
  return Boolean(
    context?.providerManagementSession === true &&
    context?.authorizationUrlSeen !== true &&
    request &&
    typeof request === "object" &&
    !Array.isArray(request) &&
    request.method === "input" &&
    !isAuthorizationCodePrompt(request) &&
    typeof request.placeholder === "string" &&
    request.placeholder.trim().toLocaleLowerCase() === "yes" &&
    asksRiskAcceptance,
  );
}

export function createOmpRiskAcknowledgementResponse(id) {
  return { type: "extension_ui_response", id, value: "yes" };
}

export function createOmpRiskAcknowledgementCancellationResponse(id) {
  return { type: "extension_ui_response", id, cancelled: true };
}
