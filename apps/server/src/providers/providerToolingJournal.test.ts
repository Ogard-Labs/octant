import { describe, expect, it } from "vitest";
import { makeProviderToolingJournalRecorder } from "./providerToolingJournal";

describe("recording a change to an account's tools", () => {
  it("writes one single-event aggregate for the local user with no field beyond the fact", () => {
    const appended: unknown[] = [];
    let counter = 0;
    const record = makeProviderToolingJournalRecorder({
      journal: { append: (request: unknown) => void appended.push(request) } as never,
      actorId: "00000000-0000-4000-8000-0000000000aa",
      uuid: () => `00000000-0000-4000-8000-${String(++counter).padStart(12, "0")}`,
      clock: () => "2026-11-01T10:00:00.000Z",
    });
    record({
      provider: "codex",
      providerInstanceId: "80000000-0000-4000-8000-0000000000a2" as never,
      commandKind: "mcp-add-url",
      name: "hosted",
      outcome: "succeeded",
      usedSecret: false,
    });
    const request = appended[0] as {
      aggregate: { aggregateType: string };
      expectedVersion: number;
      events: Array<{
        eventName: string;
        actor: { kind: string };
        payload: Record<string, unknown>;
      }>;
    };
    expect(request.aggregate.aggregateType).toBe("provider-tooling");
    expect(request.expectedVersion).toBe(0);
    expect(request.events[0]?.eventName).toBe("provider.tooling-applied@1");
    expect(request.events[0]?.actor.kind).toBe("local-user");
    expect(Object.keys(request.events[0]?.payload ?? {}).sort()).toEqual([
      "commandKind",
      "name",
      "outcome",
      "provider",
      "providerInstanceId",
      "usedSecret",
    ]);
  });
});
