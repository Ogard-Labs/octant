import { describe, expect, it, vi } from "vitest";
import { createComposerModeMenuRegistry } from "./composerModeMenu";

describe("composer mode menu bridge", () => {
  it("opens a mounted thread composer's mode menu immediately", () => {
    const registry = createComposerModeMenuRegistry();
    const open = vi.fn();
    const unregister = registry.register("thread-1", open);

    expect(registry.hasOpener("thread-1")).toBe(true);
    expect(registry.open("thread-1")).toBe(true);
    expect(open).toHaveBeenCalledOnce();

    unregister();
    expect(registry.hasOpener("thread-1")).toBe(false);
  });

  it("defers opening until the thread composer mounts when invoked from another tab", async () => {
    let time = 1_000;
    const registry = createComposerModeMenuRegistry(() => time);
    const open = vi.fn();

    expect(registry.open("thread-1")).toBe(false);
    const unregister = registry.register("thread-1", open);
    await Promise.resolve();
    expect(open).toHaveBeenCalledOnce();
    unregister();

    // An expired pending request never pops open a mode menu later.
    expect(registry.open("thread-2")).toBe(false);
    time += 10_000;
    const lateOpen = vi.fn();
    const unregisterLate = registry.register("thread-2", lateOpen);
    await Promise.resolve();
    expect(lateOpen).not.toHaveBeenCalled();
    unregisterLate();
  });
});
