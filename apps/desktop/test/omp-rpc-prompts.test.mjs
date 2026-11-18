import assert from "node:assert/strict";
import test from "node:test";
import {
  createOmpRiskAcknowledgementCancellationResponse,
  createOmpRiskAcknowledgementResponse,
  isAuthorizationCodePrompt,
  isOmpPreAuthRiskAcknowledgementPrompt,
} from "../src/lib/omp-rpc-prompts.mjs";

test("OMP provider login distinguishes pre-auth risk acknowledgement from ordinary input", () => {
  const warning = { method: "input", title: "Use this provider at your own risk. Type yes to accept and continue.", placeholder: "yes" };
  assert.equal(isOmpPreAuthRiskAcknowledgementPrompt(warning, {
    providerManagementSession: true,
    authorizationUrlSeen: false,
  }), true);
  assert.equal(isOmpPreAuthRiskAcknowledgementPrompt(warning, {
    providerManagementSession: false,
    authorizationUrlSeen: false,
  }), false);
  assert.equal(isOmpPreAuthRiskAcknowledgementPrompt(warning, {
    providerManagementSession: true,
    authorizationUrlSeen: true,
  }), false);
  assert.equal(isOmpPreAuthRiskAcknowledgementPrompt({ method: "input", message: "Paste authorization code" }, {
    providerManagementSession: true,
    authorizationUrlSeen: false,
  }), false);
  assert.equal(isOmpPreAuthRiskAcknowledgementPrompt({ ...warning, placeholder: "Enter a value" }, {
    providerManagementSession: true,
    authorizationUrlSeen: false,
  }), false, "ordinary input with warning-like text must not be promoted without OMP's yes placeholder");
  assert.equal(isOmpPreAuthRiskAcknowledgementPrompt({ method: "input", title: "Continue?", placeholder: "yes" }, {
    providerManagementSession: true,
    authorizationUrlSeen: false,
  }), false, "a generic yes/no input is not an OMP provider risk warning");
  assert.equal(isOmpPreAuthRiskAcknowledgementPrompt({ method: "input", title: "Use this provider at your own risk", placeholder: "yes" }, {
    providerManagementSession: true,
    authorizationUrlSeen: false,
  }), true);
  assert.equal(isAuthorizationCodePrompt({ method: "input", message: "Paste authorization code" }), true);
});

test("accepting an OMP provider login warning sends the exact native affirmative response", () => {
  assert.deepEqual(createOmpRiskAcknowledgementResponse("risk-prompt-1"), {
    type: "extension_ui_response",
    id: "risk-prompt-1",
    value: "yes",
  });
  assert.deepEqual(createOmpRiskAcknowledgementCancellationResponse("risk-prompt-1"), {
    type: "extension_ui_response",
    id: "risk-prompt-1",
    cancelled: true,
  });
});
