import {
  decodeProjectId,
  type CodeProjectPullRequestBackgroundRefreshState,
} from "@octant/contracts";
import { describe, expect, it } from "vitest";
import { CodeProjectPullRequestCadence } from "./codeProjectPullRequestCadence";
import type { CodeProjectPullRequestCadenceObservation } from "./codeProjectPullRequestService";

const projectA = decodeProjectId("10000000-0000-4000-8000-000000000001");
const projectB = decodeProjectId("10000000-0000-4000-8000-000000000002");

function fixture(options: {
  readonly projects: () => ReadonlyArray<{ projectId: typeof projectA; enabled: boolean }>;
  readonly identities?: (projectId: unknown) => boolean;
  readonly outcomes?: ReadonlyArray<CodeProjectPullRequestCadenceObservation>;
  readonly ghAvailable?: boolean;
}) {
  const observed: string[] = [];
  const states: CodeProjectPullRequestBackgroundRefreshState[] = [];
  let outcomeIndex = 0;
  const clock = { nowMs: 1_000_000 };
  const cadence = new CodeProjectPullRequestCadence({
    projects: options.projects,
    hasBoardRelevantIdentities: (projectId) => (options.identities ?? (() => true))(projectId),
    observe: async (projectId) => {
      observed.push(String(projectId));
      const outcome = options.outcomes?.[outcomeIndex] ?? { status: "fresh" };
      outcomeIndex += 1;
      return outcome;
    },
    onState: (state) => states.push(state),
    ghAvailable: options.ghAvailable ?? true,
    clock: () => clock.nowMs,
  });
  return { cadence, observed, states, clock };
}

describe("pull-request background refresh cadence", () => {
  it("observes only enabled projects with board-relevant identities", async () => {
    const { cadence, observed } = fixture({
      projects: () => [
        { projectId: projectA, enabled: true },
        { projectId: projectB, enabled: false },
      ],
      identities: (projectId) => String(projectId) === String(projectA),
    });
    await cadence.pass();
    expect(observed).toEqual([String(projectA)]);
  });

  it("a disabled fleet performs no observation at all, keeping the default explicit-refresh-only model", async () => {
    const { cadence, observed, states } = fixture({
      projects: () => [
        { projectId: projectA, enabled: false },
        { projectId: projectB, enabled: false },
      ],
    });
    await cadence.pass();
    await cadence.pass();
    expect(observed).toEqual([]);
    expect(states.every((state) => state.state === "disabled")).toBe(true);
  });

  it("a hundred unchanged passes observe once per interval and touch only the injected read surfaces", async () => {
    const { cadence, observed, clock } = fixture({
      projects: () => [{ projectId: projectA, enabled: true }],
    });
    await cadence.pass();
    expect(observed).toHaveLength(1);
    for (let index = 0; index < 100; index += 1) {
      clock.nowMs += 1_000;
      await cadence.pass();
    }
    // 100 seconds elapsed is still inside the 120s interval: one observation.
    expect(observed).toHaveLength(1);
    clock.nowMs += 120_000;
    await cadence.pass();
    expect(observed).toHaveLength(2);
  });

  it("a failed observation backs off and never advances the sync position", async () => {
    const { cadence, observed, states, clock } = fixture({
      projects: () => [{ projectId: projectA, enabled: true }],
      outcomes: [{ status: "failed", reason: "timeout" }, { status: "fresh" }],
    });
    await cadence.pass();
    expect(observed).toHaveLength(1);
    expect(states.at(-1)).toMatchObject({ state: "backing-off" });
    expect(states.at(-1)?.nextObservationAt).toBeDefined();

    clock.nowMs += 1_000;
    await cadence.pass();
    // Backoff holds: no hot retry.
    expect(observed).toHaveLength(1);

    clock.nowMs += 30_000;
    await cadence.pass();
    // The position never advanced on failure, so once the backoff clears the
    // very next pass observes rather than waiting a full interval.
    expect(observed).toHaveLength(2);
    expect(states.at(-1)).toMatchObject({ state: "scheduled" });
  });

  it("an unauthorized observation stops the cadence until the project is re-enabled", async () => {
    let enabled = true;
    const { cadence, observed, states, clock } = fixture({
      projects: () => [{ projectId: projectA, enabled }],
      outcomes: [{ status: "unauthorized" }, { status: "fresh" }],
    });
    await cadence.pass();
    expect(observed).toHaveLength(1);
    expect(states.at(-1)).toMatchObject({ state: "unavailable" });

    clock.nowMs += 10_000_000;
    await cadence.pass();
    await cadence.pass();
    // A refusal is never retried on a timer, however long we wait.
    expect(observed).toHaveLength(1);

    enabled = false;
    await cadence.pass();
    enabled = true;
    clock.nowMs += 1_000;
    await cadence.pass();
    expect(observed).toHaveLength(2);
  });

  it("reports unavailable without observing when gh is missing", async () => {
    const { cadence, observed, states } = fixture({
      projects: () => [{ projectId: projectA, enabled: true }],
      ghAvailable: false,
    });
    await cadence.pass();
    expect(observed).toEqual([]);
    expect(states.at(-1)).toMatchObject({ state: "unavailable" });
  });

  it("stops observing once stop is called", async () => {
    const { cadence, observed, clock } = fixture({
      projects: () => [{ projectId: projectA, enabled: true }],
    });
    await cadence.pass();
    cadence.stop();
    clock.nowMs += 600_000;
    await cadence.pass();
    expect(observed).toHaveLength(1);
  });
});
