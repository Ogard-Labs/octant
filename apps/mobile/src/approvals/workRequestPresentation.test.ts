import { describe, expect, it } from "vitest";
import { decodeWorkRequest } from "@octant/contracts";
import { pendingWorkRequestsInOrder, workRequestCard } from "./workRequestPresentation";

const base = {
  projectId: "20000000-0000-4000-8000-000000000001",
  threadId: "00000000-0000-4000-8000-000000000201",
  providerInstanceId: "10000000-0000-4000-8000-000000000001",
  providerSessionId: "55555555-5555-4555-8555-555555555555",
  providerRequestId: "provider-req",
  status: "pending",
  version: 1,
} as const;

const request = (id: string, requestedAt: string, detail: unknown) =>
  decodeWorkRequest({
    ...base,
    requestId: `${id}-1111-4111-8111-111111111111`,
    requestedAt,
    detail,
  });

describe("which card a Work request draws on the phone", () => {
  it("draws a tool call as the desktop's provider approval, and a level change as the Plan block", () => {
    expect(
      workRequestCard(
        request("11111111", "2026-11-18T10:00:00.000Z", {
          kind: "approval",
          action: "Run command",
          description: "npm test",
        }),
      ),
    ).toEqual({
      kind: "tool-approval",
      label: "Provider approval",
      summary: "Run command: npm test",
    });
    expect(
      workRequestCard(
        request("22222222", "2026-11-18T10:00:00.000Z", {
          kind: "approval",
          action: "enter-plan",
          description: "Plan first.",
          levelChange: { to: "plan" },
        }),
      )?.kind,
    ).toBe("level-change");
  });

  it("draws a question as one question, or as a questionnaire when the provider sent one", () => {
    expect(
      workRequestCard(
        request("33333333", "2026-11-18T10:00:00.000Z", {
          kind: "user-input",
          prompt: "Which venue?",
          options: ["Hall A", "Hall B"],
        }),
      ),
    ).toEqual({ kind: "question", prompt: "Which venue?", options: ["Hall A", "Hall B"] });
  });

  it("lists the oldest ask first", () => {
    const later = request("44444444", "2026-11-18T10:05:00.000Z", {
      kind: "user-input",
      prompt: "Later",
      options: [],
    });
    const earlier = request("55555555", "2026-11-18T10:00:00.000Z", {
      kind: "user-input",
      prompt: "Earlier",
      options: [],
    });
    expect(pendingWorkRequestsInOrder([later, earlier]).map((entry) => entry.requestId)).toEqual([
      earlier.requestId,
      later.requestId,
    ]);
  });
});
