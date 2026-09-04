import { describe, expect, it } from "vitest";
import type { WorkFileWatchPort } from "./workFileWatchPort";
import { WorkTurnFileObserver } from "./workTurnFileObserver";

interface Harness {
  readonly port: WorkFileWatchPort;
  change(relativePath: string | undefined): void;
  fail(): void;
  closed(): number;
}

function watchHarness(): Harness {
  let onChange: ((relativePath: string | undefined) => void) | undefined;
  let onFailure: (() => void) | undefined;
  let closes = 0;
  return {
    port: {
      watch(_root, change, failure) {
        onChange = change;
        onFailure = failure;
        return {
          close: () => {
            closes += 1;
          },
        };
      },
    },
    change: (relativePath) => onChange?.(relativePath),
    fail: () => onFailure?.(),
    closed: () => closes,
  };
}

describe("WorkTurnFileObserver", () => {
  it("records the files that changed while the turn ran", () => {
    const harness = watchHarness();
    const observation = new WorkTurnFileObserver({ watchPort: harness.port }).observe("/work");

    harness.change("summary.md");
    harness.change("research/interview.txt");
    // The same file written twice is one file, not two.
    harness.change("summary.md");

    expect(observation.finish()).toEqual({
      paths: ["research/interview.txt", "summary.md"],
      truncated: false,
    });
    expect(harness.closed()).toBe(1);
  });

  it("records nothing when the folder did not change", () => {
    const harness = watchHarness();
    const observation = new WorkTurnFileObserver({ watchPort: harness.port }).observe("/work");

    expect(observation.finish()).toBeUndefined();
  });

  it("refuses a name that would escape the bound folder and says the record is incomplete", () => {
    const harness = watchHarness();
    const observation = new WorkTurnFileObserver({ watchPort: harness.port }).observe("/work");

    harness.change("../elsewhere/secrets.txt");
    harness.change("summary.md");

    expect(observation.finish()).toEqual({ paths: ["summary.md"], truncated: true });
  });

  it("says the record is incomplete when the host reported a change it could not name", () => {
    const harness = watchHarness();
    const observation = new WorkTurnFileObserver({ watchPort: harness.port }).observe("/work");

    harness.change(undefined);

    expect(observation.finish()).toEqual({ paths: [], truncated: true });
  });

  it("says the record is incomplete when the watcher was dropped mid-turn", () => {
    const harness = watchHarness();
    const observation = new WorkTurnFileObserver({ watchPort: harness.port }).observe("/work");

    harness.change("summary.md");
    harness.fail();

    // The changes made after the drop are already lost, so reporting the paths
    // seen before it as though they were all of them would be undetectable.
    expect(observation.finish()).toEqual({ paths: ["summary.md"], truncated: true });
  });

  it("keeps hidden platform churn out of what a turn is said to have written", () => {
    const harness = watchHarness();
    const observation = new WorkTurnFileObserver({ watchPort: harness.port }).observe("/work");

    harness.change(".DS_Store");
    harness.change("research/.cache/blob");

    expect(observation.finish()).toBeUndefined();
  });

  it("bounds the record and says so rather than naming every path a turn touched", () => {
    const harness = watchHarness();
    const observation = new WorkTurnFileObserver({
      watchPort: harness.port,
      maxPaths: 2,
    }).observe("/work");

    harness.change("a.txt");
    harness.change("b.txt");
    harness.change("c.txt");

    expect(observation.finish()).toEqual({ paths: ["a.txt", "b.txt"], truncated: true });
  });

  it("stops watching once, and ignores a change reported after the turn settled", () => {
    const harness = watchHarness();
    const observation = new WorkTurnFileObserver({ watchPort: harness.port }).observe("/work");

    harness.change("summary.md");
    expect(observation.finish()).toEqual({ paths: ["summary.md"], truncated: false });

    harness.change("late.md");
    expect(observation.finish()).toBeUndefined();
    expect(harness.closed()).toBe(1);
  });
});
