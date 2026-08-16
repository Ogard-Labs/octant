import { describe, expect, it } from "vitest";
import {
  MAX_NEW_THREAD_DRAFT_INTENT_BYTES,
  decodeValidatedThreadDraft,
  decodeValidatedThreadCreationResult,
} from "./threadCreation";

const draft = {
  draftId: "11111111-1111-4111-8111-111111111111",
  intent: "Investigate the failed focused test.",
  context: {
    hostId: "local",
    mode: "code",
    projectId: "22222222-2222-4222-8222-222222222222",
    providerInstanceId: "33333333-3333-4333-8333-333333333333",
    modelId: "model-a",
    authority: {
      kind: "code",
      bindingRevisionId: "44444444-4444-4444-8444-444444444444",
      repositoryId: `repo_${"a".repeat(64)}`,
      checkoutId: "55555555-5555-4555-8555-555555555555",
      executionPolicy: "approval-gated",
      permissionPersistence: "current-session",
    },
  },
} as const;

describe("ValidatedThreadDraft", () => {
  it("decodes a strict Code draft with resolved authority", () => {
    expect(decodeValidatedThreadDraft(draft)).toEqual(draft);
  });

  it("rejects a mode/authority mismatch and oversized draft intent", () => {
    expect(() =>
      decodeValidatedThreadDraft({ ...draft, context: { ...draft.context, mode: "chat" } }),
    ).toThrow();
    expect(() =>
      decodeValidatedThreadDraft({
        ...draft,
        intent: "a".repeat(MAX_NEW_THREAD_DRAFT_INTENT_BYTES + 1),
      }),
    ).toThrow();
  });
});

describe("ValidatedThreadCreationResult", () => {
  it("carries the unchanged draft through a typed invalid-context result", () => {
    const result = { kind: "invalid-context", field: "provider", draft } as const;
    expect(decodeValidatedThreadCreationResult(result)).toEqual(result);
  });
});
