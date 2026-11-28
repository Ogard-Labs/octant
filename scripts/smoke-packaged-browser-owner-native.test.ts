import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  assertFixedFolderStageReceipt,
  workModeEntryReady,
} from "./smoke-packaged-browser-owner-native";

// Rows as the packaged app's accessibility tree gave them: Settings lists its
// Work section by title, and the app's Work button carries a description.
const settingsWorkRow = "AXButton | Work |  | ";
const appWorkRow = "AXButton |  | Work | ";

const pickerGoReceipt = (overrides?: Readonly<Record<string, unknown>>): string =>
  JSON.stringify({
    capturedPid: 4242,
    capturedIdentityMatched: true,
    directoryLabelsRead: false,
    readErrors: 2,
    nativeErrors: [
      { stage: "picker-focus", status: -25202 },
      { stage: "focus-ancestor-parent", status: -25202 },
    ],
    fixedFolder: {
      status: "completed",
      goDispatched: true,
      postGoOriginalChooserObserved: true,
      postGoPollAttempts: 3,
      postGoTransientInvalidElementErrors: 2,
      fixtureIdentityMatched: true,
      rawValueCaptured: false,
      codeSigningVerified: true,
      fixedOwnedFieldValueCompared: true,
      fixedOwnedFieldValueMatched: true,
      ...overrides,
    },
  });

describe("packaged Browser owner native smoke", () => {
  it("keeps waiting while Settings is open with a Work section of its own", () => {
    expect(
      workModeEntryReady(["AXButton |  | Close Settings | ", settingsWorkRow].join("\n")),
    ).toBe(false);
    expect(workModeEntryReady(["AXButton | Back to app |  | ", settingsWorkRow].join("\n"))).toBe(
      false,
    );
  });

  it("waits for Settings to leave while the app's Work button is already drawn behind it", () => {
    expect(
      workModeEntryReady(
        [appWorkRow, "AXButton |  | Close Settings | ", settingsWorkRow].join("\n"),
      ),
    ).toBe(false);
  });

  it("keeps waiting once Settings is gone until the app's Work button is drawn", () => {
    expect(workModeEntryReady("AXButton |  | Code | ")).toBe(false);
  });

  it("finds the app's Work button once Settings is gone", () => {
    expect(workModeEntryReady([appWorkRow, "AXButton |  | Code | "].join("\n"))).toBe(true);
  });

  it("accepts a post-Return folder receipt that completed after transient invalid-element reads", () => {
    expect(() =>
      assertFixedFolderStageReceipt("picker-go-owned-location", 4242, pickerGoReceipt()),
    ).not.toThrow();
  });

  it("refuses a post-Return folder receipt that stopped unconfirmed or never observed the chooser sheet", () => {
    expect(() =>
      assertFixedFolderStageReceipt(
        "picker-go-owned-location",
        4242,
        pickerGoReceipt({ status: "go-dispatched-shape-unconfirmed" }),
      ),
    ).toThrow("Owned-folder command refused or remained uncertain; no replay.");
    expect(() =>
      assertFixedFolderStageReceipt(
        "picker-go-owned-location",
        4242,
        pickerGoReceipt({ postGoOriginalChooserObserved: false }),
      ),
    ).toThrow("Post-Return poll did not observe the original chooser sheet; no replay.");
    expect(() =>
      assertFixedFolderStageReceipt("picker-go-owned-location", 9999, pickerGoReceipt()),
    ).toThrow("Owned-folder command lost its captured process; no replay.");
  });

  it.runIf(process.platform === "darwin")(
    "tolerates transient -25202 reads in the Swift post-Return poll without resending Return and stops on other errors, identity loss, or deadline",
    async () => {
      const swiftSource = fileURLToPath(
        new URL("./packaged-browser-owner-ax.swift", import.meta.url),
      );
      const directory = await mkdtemp(join(tmpdir(), "octant-ax-poll-test."));
      try {
        // Verify the unmodified production Swift controller still typechecks cleanly.
        execFileSync("/usr/bin/xcrun", ["swiftc", "-typecheck", swiftSource], {
          stdio: "pipe",
          timeout: 30_000,
        });

        const fullSource = await readFile(swiftSource, "utf8");
        const entryMarker = "// Owned-runner native UI QA.";
        const entryOffset = fullSource.indexOf(entryMarker);
        expect(entryOffset).toBeGreaterThan(0);
        const pollHelpers = fullSource.slice(0, entryOffset);

        const harnessPath = join(directory, "main.swift");
        const binaryPath = join(directory, "ax-poll-tests");
        await writeFile(
          harnessPath,
          `${pollHelpers}\n${String.raw`
func expect(_ condition: Bool, _ message: String) {
    if !condition {
        fputs("FAIL: \(message)\n", stderr)
        exit(1)
    }
}

// 1. Error classification admits only -25202 with intact log capacity.
expect(
    postGoOnlyInvalidElementErrors(
        errorsAdded: 1,
        recordedStatuses: [AXError.invalidUIElement.rawValue],
        logCapacityReached: false
    ),
    "single -25202 should be classified as transient"
)
expect(
    postGoOnlyInvalidElementErrors(
        errorsAdded: 2,
        recordedStatuses: [-25202, -25202, -25202],
        logCapacityReached: false
    ),
    "multiple -25202 statuses in one read step should be classified as transient"
)
expect(
    !postGoOnlyInvalidElementErrors(
        errorsAdded: 1,
        recordedStatuses: [AXError.cannotComplete.rawValue],
        logCapacityReached: false
    ),
    "non-invalid-element error (-25204) must fail closed"
)
expect(
    !postGoOnlyInvalidElementErrors(
        errorsAdded: 2,
        recordedStatuses: [-25202, AXError.apiDisabled.rawValue],
        logCapacityReached: false
    ),
    "mixed -25202 and another error must fail closed"
)
expect(
    !postGoOnlyInvalidElementErrors(
        errorsAdded: 1,
        recordedStatuses: [AXError.success.rawValue],
        logCapacityReached: false
    ),
    "node-limit/non-element status 0 must fail closed"
)
expect(
    !postGoOnlyInvalidElementErrors(
        errorsAdded: 1,
        recordedStatuses: [-25202],
        logCapacityReached: true
    ),
    "log capacity exhaustion must fail closed"
)
expect(
    !postGoOnlyInvalidElementErrors(
        errorsAdded: 2,
        recordedStatuses: [-25202],
        logCapacityReached: false
    ),
    "fewer recorded statuses than errors added must fail closed"
)

// 2. Poll tolerates transient -25202 and pending reads until the original sheet settles.
do {
    let steps: [PostGoPollStep] = [.transientInvalidElement, .pending, .transientInvalidElement, .completed]
    var index = 0
    var pauses = 0
    let outcome = pollPostGoObservation(
        hasTimeRemaining: { true },
        identitiesValid: { true },
        readStep: {
            let step = steps[index]
            index += 1
            return step
        },
        pause: { pauses += 1 }
    )
    expect(outcome == PostGoPollOutcome(completed: true, attempts: 4, transientInvalidElementCount: 2, stoppedOnNonTransientError: false), "expected completion after transient -25202 reads")
    expect(pauses == 3, "expected one pause per non-terminal read")
}

// 3. Poll stops immediately on a non-transient error without sleeping or polling further.
do {
    let steps: [PostGoPollStep] = [.transientInvalidElement, .failed, .completed]
    var index = 0
    var pauses = 0
    let outcome = pollPostGoObservation(
        hasTimeRemaining: { true },
        identitiesValid: { true },
        readStep: {
            let step = steps[index]
            index += 1
            return step
        },
        pause: { pauses += 1 }
    )
    expect(outcome == PostGoPollOutcome(completed: false, attempts: 2, transientInvalidElementCount: 1, stoppedOnNonTransientError: true), "expected immediate stop on non-transient error")
    expect(pauses == 1, "must not pause after non-transient failure")
}

// 4. Poll stops when the deadline expires even if every read hits -25202.
do {
    var ticksRemaining = 3
    var pauses = 0
    let outcome = pollPostGoObservation(
        hasTimeRemaining: { ticksRemaining > 0 },
        identitiesValid: { true },
        readStep: {
            ticksRemaining -= 1
            return .transientInvalidElement
        },
        pause: { pauses += 1 }
    )
    expect(outcome == PostGoPollOutcome(completed: false, attempts: 3, transientInvalidElementCount: 3, stoppedOnNonTransientError: false), "expected deadline expiry to leave poll unconfirmed")
    expect(pauses == 2, "must not pause after deadline expires")
}

// 5. Poll stops immediately when process or fixture identity drifts.
do {
    var valid = true
    var pauses = 0
    let outcome = pollPostGoObservation(
        hasTimeRemaining: { true },
        identitiesValid: { valid },
        readStep: {
            valid = false
            return .transientInvalidElement
        },
        pause: { pauses += 1 }
    )
    expect(outcome == PostGoPollOutcome(completed: false, attempts: 1, transientInvalidElementCount: 1, stoppedOnNonTransientError: false), "expected identity loss to stop poll immediately")
    expect(pauses == 0, "must not pause after identity loss")
}

print("ok")
`}`,
          "utf8",
        );

        execFileSync("/usr/bin/xcrun", ["swiftc", harnessPath, "-o", binaryPath], {
          stdio: "pipe",
          timeout: 30_000,
        });
        const output = execFileSync(binaryPath, [], { encoding: "utf8", timeout: 10_000 });
        expect(output.trim()).toBe("ok");
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
    60_000,
  );
});
