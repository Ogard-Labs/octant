import { decodeWorkspaceTabId } from "@octant/contracts/shell";
import { describe, expect, it, vi } from "vitest";
import { createTabActivationRegistry } from "./TabActivation";

const tabA = decodeWorkspaceTabId("11111111-1111-4111-8111-111111111111");
const tabB = decodeWorkspaceTabId("22222222-2222-4222-8222-222222222222");

describe("tab activation registry", () => {
  it("notifies the listeners seated when the activation happens", () => {
    const registry = createTabActivationRegistry();
    const first = vi.fn();
    const second = vi.fn();
    registry.subscribe(first);
    registry.subscribe(second);

    registry.noteActivated(tabA);

    expect(first).toHaveBeenCalledOnce();
    expect(second).toHaveBeenCalledOnce();
  });

  it("does not call a listener that subscribed during the same dispatch", () => {
    const registry = createTabActivationRegistry();
    const late = vi.fn();
    registry.subscribe(() => {
      registry.subscribe(late);
    });

    registry.noteActivated(tabA);

    expect(late).not.toHaveBeenCalled();
    registry.noteActivated(tabB);
    expect(late).toHaveBeenCalledOnce();
  });

  it("keeps one dispatch to the listeners seated when it began", () => {
    const registry = createTabActivationRegistry();
    const seated = vi.fn();
    let unsubscribeSeated: () => void = () => undefined;
    // The remover is seated first, so only a snapshot keeps the later
    // listener in this pass; a live iterator would never reach it.
    registry.subscribe(() => unsubscribeSeated());
    unsubscribeSeated = registry.subscribe(seated);

    registry.noteActivated(tabA);

    expect(seated).toHaveBeenCalledOnce();
    // The next activation no longer sees it.
    registry.noteActivated(tabB);
    expect(seated).toHaveBeenCalledOnce();
  });
});
