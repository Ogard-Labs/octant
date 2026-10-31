import { describe, expect, it } from "vitest";
import { appleDiagnostics } from "./AppleDevicePane";
import type { AppleWorkbenchPaneProps } from "./AppleWorkbenchPane";

const evidence = (actionId: string, requestedBy: { kind: string; actorId: string }) => ({
  actionId,
  kind: "tap",
  outcome: "succeeded",
  requestedBy,
  diagnostics: [{ severity: "note", message: "tap completed" }],
  completedAt: "2026-10-31T00:30:00.000Z",
});

describe("iOS Simulator Diagnostics", () => {
  it("says who asked on each recent row: the agent's tap and a person's tap", () => {
    const props = {
      runtime: {
        active: [],
        recentEvidence: [
          evidence("1", { kind: "agent", actorId: "a" }),
          evidence("2", { kind: "local-user", actorId: "b" }),
        ],
      },
    } as unknown as AppleWorkbenchPaneProps;

    expect(
      appleDiagnostics(props).recent.map(({ label, requestedBy }) => [label, requestedBy]),
    ).toEqual([
      ["Tap", "You"],
      ["Tap", "Agent"],
    ]);
  });
});
