import { decodeProviderInstanceId } from "@octant/contracts";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { ANTIGRAVITY_USAGE_ARGS, makeAntigravityUsageFacts } from "./antigravityUsage";

const instanceId = decodeProviderInstanceId("80000000-0000-4000-8000-000000000a01");
const clock = () => "2026-11-20T12:00:00.000Z";

function reading(body: unknown) {
  const calls: Array<ReadonlyArray<string>> = [];
  const facts = makeAntigravityUsageFacts({
    instanceId,
    binaryPath: "/usr/local/bin/agy",
    clock,
    readings: new Map(),
    runUsage: async (_binary, args) => {
      calls.push(args);
      return typeof body === "string" ? body : JSON.stringify(body);
    },
  });
  return {
    calls,
    read: () =>
      Effect.runPromise(
        Effect.scoped(Effect.either(facts.observeServiceLimits({ instanceId, onDemand: true }))),
      ),
  };
}

describe("Google Antigravity limits from its own usage command", () => {
  it("reads each enabled bucket's share used and reset, through agy -p /usage", async () => {
    const { calls, read } = reading({
      status: "SUCCESS",
      command: {
        name: "usage",
        data: {
          groups: [
            {
              name: "Gemini",
              buckets: [
                {
                  id: "g5",
                  name: "5h",
                  window: "5h",
                  remaining_fraction: 0.75,
                  reset_time: "2026-11-20T15:00:00Z",
                },
                { id: "gw", name: "Weekly", window: "weekly", remaining_fraction: 0.1 },
              ],
            },
            {
              name: "Claude & GPT",
              buckets: [{ id: "3p", name: "Weekly", window: "weekly", disabled: true }],
            },
          ],
        },
      },
    });
    const result = await read();
    expect(calls).toEqual([ANTIGRAVITY_USAGE_ARGS]);
    if (result._tag !== "Right") throw new Error("Expected limits");
    expect(result.right.rateLimitWindows).toEqual([
      expect.objectContaining({
        window: "Gemini · 5h",
        utilization: 0.25,
        status: "allowed",
        resetsAt: "2026-11-20T15:00:00.000Z",
      }),
      expect.objectContaining({ window: "Gemini · Weekly", utilization: 0.9, status: "warning" }),
    ]);
  });

  it.each([
    ["a failed reading", { status: "ERROR", error: "not signed in" }],
    ["output that is not JSON", "Please sign in"],
    [
      "a fraction outside 0 to 1",
      {
        status: "SUCCESS",
        command: {
          data: { groups: [{ name: "G", buckets: [{ name: "5h", remaining_fraction: 2 }] }] },
        },
      },
    ],
  ])("refuses %s rather than reading it as unused", async (_label, body) => {
    const result = await reading(body).read();
    expect(result._tag).toBe("Left");
  });
});
