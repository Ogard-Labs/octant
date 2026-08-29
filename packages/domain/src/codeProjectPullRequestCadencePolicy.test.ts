import { describe, expect, it } from "vitest";
import {
  CODE_PROJECT_PULL_REQUEST_CADENCE_FLOOR_MS,
  CODE_PROJECT_PULL_REQUEST_CADENCE_INTERVAL_MS,
  decidePullRequestCadenceObservation,
  restartPullRequestCadence,
  settlePullRequestCadenceObservation,
} from "./codeProjectPullRequestCadencePolicy";

const base = {
  enabled: true,
  hasBoardRelevantIdentities: true,
  ghAvailable: true,
} as const;

describe("pull-request cadence policy", () => {
  it("observes immediately when the project has never been observed", () => {
    expect(decidePullRequestCadenceObservation({ ...base, state: {}, nowMs: 1_000 })).toEqual({
      kind: "observe",
    });
  });

  it("waits the full interval after a successful observation", () => {
    const state = settlePullRequestCadenceObservation({}, { status: "fresh" }, 10_000);
    expect(state.lastFreshAtMs).toBe(10_000);
    expect(decidePullRequestCadenceObservation({ ...base, state, nowMs: 20_000 })).toEqual({
      kind: "wait",
      untilMs: 10_000 + CODE_PROJECT_PULL_REQUEST_CADENCE_INTERVAL_MS,
    });
    expect(
      decidePullRequestCadenceObservation({
        ...base,
        state,
        nowMs: 10_000 + CODE_PROJECT_PULL_REQUEST_CADENCE_INTERVAL_MS,
      }),
    ).toEqual({ kind: "observe" });
  });

  it("waits at least the cadence floor even when the configured interval is shorter", () => {
    const state = settlePullRequestCadenceObservation({}, { status: "fresh" }, 0);
    expect(
      decidePullRequestCadenceObservation({ ...base, state, nowMs: 5_000, intervalMs: 1_000 }),
    ).toEqual({ kind: "wait", untilMs: CODE_PROJECT_PULL_REQUEST_CADENCE_FLOOR_MS });
  });

  it("treats an authoritative empty list as a successful observation", () => {
    const state = settlePullRequestCadenceObservation({}, { status: "empty" }, 7_000);
    expect(state.lastFreshAtMs).toBe(7_000);
    expect(state.backoff).toBeUndefined();
  });

  it("a failed observation never advances the sync position", () => {
    const fresh = settlePullRequestCadenceObservation({}, { status: "fresh" }, 10_000);
    const failed = settlePullRequestCadenceObservation(fresh, { status: "failed" }, 200_000);
    expect(failed.lastFreshAtMs).toBe(10_000);
    expect(failed.backoff?.failureStreak).toBe(1);
  });

  it("consecutive failures back off further and a success clears the streak", () => {
    const first = settlePullRequestCadenceObservation({}, { status: "failed" }, 0);
    const second = settlePullRequestCadenceObservation(first, { status: "failed" }, 60_000);
    expect(first.backoff).toBeDefined();
    expect(second.backoff).toBeDefined();
    if (first.backoff === undefined || second.backoff === undefined) return;
    expect(second.backoff.retryAt - 60_000).toBeGreaterThan(first.backoff.retryAt);
    expect(decidePullRequestCadenceObservation({ ...base, state: second, nowMs: 61_000 })).toEqual({
      kind: "wait",
      untilMs: second.backoff.retryAt,
    });
    const recovered = settlePullRequestCadenceObservation(second, { status: "fresh" }, 900_000);
    expect(recovered.backoff).toBeUndefined();
    expect(recovered.lastFreshAtMs).toBe(900_000);
  });

  it("a rate limit's retry-after extends the wait beyond the streak delay", () => {
    const state = settlePullRequestCadenceObservation(
      {},
      { status: "failed", retryAtMs: 600_000 },
      0,
    );
    expect(state.backoff?.retryAt).toBe(600_000);
  });

  it("stops when gh is unavailable instead of retrying a refusal", () => {
    expect(
      decidePullRequestCadenceObservation({ ...base, ghAvailable: false, state: {}, nowMs: 0 }),
    ).toEqual({ kind: "stopped", reason: "gh-unavailable" });
  });

  it("an unauthorized observation stops the cadence until it is explicitly restarted", () => {
    const fresh = settlePullRequestCadenceObservation({}, { status: "fresh" }, 10_000);
    const stopped = settlePullRequestCadenceObservation(fresh, { status: "unauthorized" }, 20_000);
    expect(stopped.stopped).toBe("unauthorized");
    expect(stopped.lastFreshAtMs).toBe(10_000);
    expect(
      decidePullRequestCadenceObservation({ ...base, state: stopped, nowMs: 10_000_000 }),
    ).toEqual({ kind: "stopped", reason: "unauthorized" });
    const restarted = restartPullRequestCadence(stopped);
    expect(restarted.stopped).toBeUndefined();
    expect(restarted.lastFreshAtMs).toBe(10_000);
  });

  it("does not observe a disabled project or one without board-relevant identities", () => {
    expect(
      decidePullRequestCadenceObservation({ ...base, enabled: false, state: {}, nowMs: 0 }),
    ).toEqual({ kind: "idle", reason: "disabled" });
    expect(
      decidePullRequestCadenceObservation({
        ...base,
        hasBoardRelevantIdentities: false,
        state: {},
        nowMs: 0,
      }),
    ).toEqual({ kind: "idle", reason: "no-identities" });
  });
});
