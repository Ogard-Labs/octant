import { decodeWorkRequest } from "@octant/contracts";
import { describe, expect, it } from "vitest";
import { levelChangePresentation } from "./levelChangePresentation";

const pending = {
  requestId: "11111111-1111-4111-8111-111111111111",
  projectId: "22222222-2222-4222-8222-222222222222",
  threadId: "33333333-3333-4333-8333-333333333333",
  providerInstanceId: "44444444-4444-4444-8444-444444444444",
  providerSessionId: "55555555-5555-4555-8555-555555555555",
  providerRequestId: "provider-req-1",
  status: "pending",
  requestedAt: "2026-08-10T08:00:00.000Z",
  version: 1,
} as const;

function request(detail: unknown) {
  return decodeWorkRequest({ ...pending, detail });
}

describe("the phone's Plan block for a Work agent's level change", () => {
  it("shows the plan whole with Approve plan at the level the thread returns to, and Keep planning", () => {
    const plan = "1. Read the config.\n2. Update the parser.\n3. Run the tests.";
    expect(
      levelChangePresentation(
        request({
          kind: "approval",
          action: "exit-plan",
          description: "The plan is ready.",
          levelChange: { to: "ask-first", plan },
        }),
      ),
    ).toEqual({
      entering: false,
      label: "Approve the plan",
      summary: "exit-plan: The plan is ready.",
      plan,
      detail: "This turn ends; the next one runs at Ask first.",
      approveLabel: "Approve plan · Ask first",
      keepLabel: "Keep planning",
    });
  });

  it("asks to plan first with Switch to Plan and Keep working", () => {
    expect(
      levelChangePresentation(
        request({
          kind: "approval",
          action: "enter-plan",
          description: "Let me plan this first.",
          levelChange: { to: "plan" },
        }),
      ),
    ).toMatchObject({
      entering: true,
      label: "Plan first",
      detail: "This turn ends; the next one runs in Plan, read-only.",
      approveLabel: "Switch to Plan",
      keepLabel: "Keep working",
    });
  });

  it("draws no Plan block for an ordinary approval or an ask already answered", () => {
    expect(
      levelChangePresentation(
        request({ kind: "approval", action: "run-terminal-command", description: "Run tests." }),
      ),
    ).toBeUndefined();
    expect(
      levelChangePresentation(
        decodeWorkRequest({
          ...pending,
          detail: {
            kind: "approval",
            action: "enter-plan",
            description: "Plan first.",
            levelChange: { to: "plan" },
          },
          status: "resolved",
          resolution: { kind: "approval", approved: true },
          settledAt: "2026-08-10T08:05:00.000Z",
        }),
      ),
    ).toBeUndefined();
  });
});
