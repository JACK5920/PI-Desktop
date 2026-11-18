export type OmpRpcPromptShape = {
  method?: unknown;
  title?: unknown;
  message?: unknown;
  placeholder?: unknown;
  instructions?: unknown;
};

export function isAuthorizationCodePrompt(request: OmpRpcPromptShape): boolean;
export function isOmpPreAuthRiskAcknowledgementPrompt(
  request: OmpRpcPromptShape,
  context: { providerManagementSession: boolean; authorizationUrlSeen: boolean },
): boolean;
export function createOmpRiskAcknowledgementResponse(id: string): {
  type: "extension_ui_response";
  id: string;
  value: "yes";
};
export function createOmpRiskAcknowledgementCancellationResponse(id: string): {
  type: "extension_ui_response";
  id: string;
  cancelled: true;
};
