import { describe, expect, it } from "vitest";
import {
  MAX_TOOL_ACTION_INTENT_BYTES,
  decodeToolActionCancellation,
  decodeToolActionOutcome,
  decodeToolActionRequest,
} from "./toolActions";

const ids = {
  action: "11111111-1111-4111-8111-111111111111",
  correlation: "22222222-2222-4222-8222-222222222222",
  host: "33333333-3333-4333-8333-333333333333",
  project: "44444444-4444-4444-8444-444444444444",
  root: "55555555-5555-4555-8555-555555555555",
  worktree: "66666666-6666-4666-8666-666666666666",
  extension: "77777777-7777-4777-8777-777777777777",
  approval: "88888888-8888-4888-8888-888888888888",
  evidence: "99999999-9999-4999-8999-999999999999",
} as const;

const authority = {
  hostId: ids.host,
  mode: "code",
  projectId: ids.project,
  rootId: ids.root,
  worktreeId: ids.worktree,
  providerInstanceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  extension: { kind: "trusted-extension", extensionId: ids.extension },
} as const;

const request = {
  actionId: ids.action,
  correlationId: ids.correlation,
  capability: { id: "repository-validation", version: 1 },
  authority,
  intent: "Run the focused validation suite.",
  approval: { kind: "approved", approvalId: ids.approval },
} as const;

describe("ToolActionRequest", () => {
  it("decodes one strict normalized request without raw root or credential data", () => {
    expect(decodeToolActionRequest(request)).toEqual(request);
  });

  it("rejects oversized intent and unknown authority fields", () => {
    expect(() =>
      decodeToolActionRequest({ ...request, intent: "a".repeat(MAX_TOOL_ACTION_INTENT_BYTES + 1) }),
    ).toThrow();
    expect(() =>
      decodeToolActionRequest({
        ...request,
        authority: { ...authority, rootPath: "/private/repo" },
      }),
    ).toThrow();
  });
});

describe("Tool action outcomes", () => {
  it("requires evidence correlation for a completed action", () => {
    const outcome = {
      kind: "completed",
      actionId: ids.action,
      correlationId: ids.correlation,
      authority,
      evidence: [
        {
          evidenceId: ids.evidence,
          actionId: ids.action,
          correlationId: ids.correlation,
          authority,
          kind: "validation-report",
          reference: "evidence-1",
          origin: "tool-result",
        },
      ],
    } as const;
    expect(decodeToolActionOutcome(outcome)).toEqual(outcome);
    expect(() =>
      decodeToolActionOutcome({
        ...outcome,
        evidence: [{ ...outcome.evidence[0], actionId: ids.approval }],
      }),
    ).toThrow();
    expect(() =>
      decodeToolActionOutcome({
        ...outcome,
        evidence: [{ ...outcome.evidence[0], authority: { ...authority, mode: "chat" } }],
      }),
    ).toThrow();
  });

  it("requires provenance origin on journaled tool evidence", () => {
    expect(() =>
      decodeToolActionOutcome({
        kind: "completed",
        actionId: ids.action,
        correlationId: ids.correlation,
        authority,
        evidence: [
          {
            evidenceId: ids.evidence,
            actionId: ids.action,
            correlationId: ids.correlation,
            authority,
            kind: "tool-output",
            reference: "evidence-1",
          },
        ],
      }),
    ).toThrow();
  });

  it("keeps every non-completed terminal state explicit", () => {
    for (const kind of [
      "unavailable",
      "unauthorized",
      "waiting",
      "interrupted",
      "inconclusive",
      "failed",
    ] as const) {
      expect(
        decodeToolActionOutcome({
          kind,
          actionId: ids.action,
          correlationId: ids.correlation,
          authority,
          reason: "capability-state",
        }),
      ).toMatchObject({ kind });
    }
  });
});

describe("ToolActionCancellation", () => {
  it("keeps cancellation scoped to one action and correlation", () => {
    const cancellation = {
      actionId: ids.action,
      correlationId: ids.correlation,
      authority,
      reason: "user-requested",
    } as const;
    expect(decodeToolActionCancellation(cancellation)).toEqual(cancellation);
    expect(() => decodeToolActionCancellation({ ...cancellation, reason: "kill -9 1" })).toThrow();
  });
});
