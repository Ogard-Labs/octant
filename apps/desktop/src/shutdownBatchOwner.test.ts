import { describe, expect, it } from "vitest";
import { ShutdownBatchOwner } from "./shutdownBatchOwner";

const MAIN = 1;
const PROJECT_A = 2;
const PROJECT_B = 3;

describe("which window owns a running Prepare to shut down batch", () => {
  it("reopens a batch owned by another window in that window, and the main one only when none runs", () => {
    const owner = new ShutdownBatchOwner();
    expect(owner.windowToOpen()).toBeUndefined();

    owner.report(PROJECT_B, { ended: 1, total: 4 });

    expect(owner.windowToOpen()).toBe(PROJECT_B);
    owner.report(PROJECT_B, undefined);
    expect(owner.windowToOpen()).toBeUndefined();
  });

  it("keeps the owner's progress when another window's empty dialog reports nothing", () => {
    const owner = new ShutdownBatchOwner();
    owner.report(PROJECT_B, { ended: 1, total: 4 });

    expect(owner.report(PROJECT_A, undefined)).toBe(false);
    expect(owner.report(MAIN, { ended: 0, total: 2 })).toBe(false);

    expect(owner.progress()).toEqual({ ended: 1, total: 4 });
    expect(owner.windowToOpen()).toBe(PROJECT_B);
    expect(owner.report(PROJECT_B, { ended: 2, total: 4 })).toBe(true);
    expect(owner.progress()).toEqual({ ended: 2, total: 4 });
  });

  it("lets go of a batch whose window closed", () => {
    const owner = new ShutdownBatchOwner();
    owner.report(PROJECT_B, { ended: 1, total: 4 });

    expect(owner.windowClosed(PROJECT_A)).toBe(false);
    expect(owner.windowClosed(PROJECT_B)).toBe(true);

    expect(owner.progress()).toBeUndefined();
    expect(owner.windowToOpen()).toBeUndefined();
    // Another window may then start and own a batch of its own.
    expect(owner.report(PROJECT_A, { ended: 0, total: 1 })).toBe(true);
    expect(owner.windowToOpen()).toBe(PROJECT_A);
  });
});
