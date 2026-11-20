import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  decodePairedBrowserNativeCommand,
  type PairedBrowserNativeTarget,
} from "@octant/contracts/paired-browser-control";
import {
  BrowserPairedControl,
  type PairedControlChooserOffer,
  type PairedControlPage,
} from "./browserPairedControl";

const ids = {
  contextId: "11111111-1111-4111-8111-111111111111",
  windowId: "22222222-2222-4222-8222-222222222222",
  threadId: "33333333-3333-4333-8333-333333333333",
  leaseId: "44444444-4444-4444-8444-444444444444",
};

function makeTarget(overrides: Partial<PairedBrowserNativeTarget> = {}): PairedBrowserNativeTarget {
  return {
    tabId: "tab-1",
    documentVersion: "a".repeat(64) as PairedBrowserNativeTarget["documentVersion"],
    origin: "https://example.com",
    originPolicyVersion: "policy-v1",
    viewport: { width: 1280, height: 800 },
    devicePixelRatio: 2,
    ...overrides,
  };
}

describe("BrowserPairedControl", () => {
  it("drops pointer events aimed at stale frames after navigation or viewport change", async () => {
    const identity = {};
    let target = makeTarget();
    let personInputs = 0;
    const dispatched = vi.fn();
    const control = new BrowserPairedControl({
      page: (): PairedControlPage => ({
        identity,
        contextId: ids.contextId,
        target,
        personInputs,
        privateCustody: false,
        nativePromptOpen: false,
        capture: async () => ({
          isEmpty: () => false,
          getSize: () => ({ width: target.viewport.width, height: target.viewport.height }),
          toJPEG: () => Uint8Array.from([0xff, 0xd8, 0xff]),
        }),
        input: async (events) => {
          personInputs += 1;
          dispatched(events);
        },
        observe: () => () => undefined,
      }),
    });
    const run = (command: Readonly<Record<string, unknown>>) =>
      control.execute(
        decodePairedBrowserNativeCommand({
          contextId: ids.contextId,
          owner: { windowId: ids.windowId, threadId: ids.threadId },
          ...command,
        }),
      );

    expect(await run({ operation: "claim", leaseId: ids.leaseId, target })).toEqual({
      status: "claimed",
    });
    const first = await run({ operation: "frame", leaseId: ids.leaseId });
    if (first.status !== "frame") throw new Error("Expected frame");

    // Simulate navigation changing documentVersion.
    target = makeTarget({
      documentVersion: "b".repeat(64) as PairedBrowserNativeTarget["documentVersion"],
    });
    expect(
      await run({
        operation: "input",
        leaseId: ids.leaseId,
        events: [{ kind: "tap", frameId: first.frame.frameId, x: 0.5, y: 0.5 }],
      }),
    ).toEqual({ status: "refused", reason: "stale-frame" });
    expect(dispatched).not.toHaveBeenCalled();

    // After receiving a fresh frame, pointer input aimed at it succeeds.
    const second = await run({ operation: "frame", leaseId: ids.leaseId });
    if (second.status !== "frame") throw new Error("Expected fresh frame");
    expect(
      await run({
        operation: "input",
        leaseId: ids.leaseId,
        events: [{ kind: "tap", frameId: second.frame.frameId, x: 0.5, y: 0.5 }],
      }),
    ).toEqual({ status: "input", effect: "completed" });
    expect(dispatched).toHaveBeenCalledOnce();
  });

  it("withholds frames during private custody, native prompts, or tab changes and forwards intercepted file choices", async () => {
    const identity = {};
    let target = makeTarget();
    let privateCustody = false;
    let nativePromptOpen = false;
    let emitChooser: ((offer: PairedControlChooserOffer) => void) | undefined;
    const resolvedFiles = vi.fn(async () => true);

    const control = new BrowserPairedControl({
      page: (): PairedControlPage => ({
        identity,
        contextId: ids.contextId,
        target,
        personInputs: 0,
        privateCustody,
        nativePromptOpen,
        capture: async () => ({
          isEmpty: () => false,
          getSize: () => ({ width: 800, height: 600 }),
          toJPEG: () => Uint8Array.from([0xff, 0xd8, 0xff]),
        }),
        input: async () => undefined,
        observe: () => () => {
          if (privateCustody) throw new Error("Private custody active");
        },
        startFileChooserInterception: (onChooser) => {
          emitChooser = onChooser;
          return () => {
            emitChooser = undefined;
          };
        },
      }),
    });
    const run = (command: Readonly<Record<string, unknown>>) =>
      control.execute(
        decodePairedBrowserNativeCommand({
          contextId: ids.contextId,
          owner: { windowId: ids.windowId, threadId: ids.threadId },
          ...command,
        }),
      );

    expect(await run({ operation: "claim", leaseId: ids.leaseId, target })).toEqual({
      status: "claimed",
    });

    privateCustody = true;
    expect(await run({ operation: "frame", leaseId: ids.leaseId })).toEqual({
      status: "withheld",
      reason: "private-custody",
    });
    privateCustody = false;

    nativePromptOpen = true;
    expect(await run({ operation: "frame", leaseId: ids.leaseId })).toEqual({
      status: "withheld",
      reason: "native-prompt",
    });
    nativePromptOpen = false;

    target = makeTarget({ tabId: "tab-2" });
    expect(await run({ operation: "frame", leaseId: ids.leaseId })).toEqual({
      status: "withheld",
      reason: "outside-document",
    });
    target = makeTarget({ tabId: "tab-1" });

    emitChooser?.({ accept: ["image/png"], multiple: false, resolve: resolvedFiles });
    const withChooser = await run({ operation: "frame", leaseId: ids.leaseId });
    if (withChooser.status !== "frame" || withChooser.fileChooser === undefined) {
      throw new Error("Expected frame carrying pending file chooser");
    }

    const dir = mkdtempSync(join(tmpdir(), "octant-paired-chooser-"));
    try {
      const staged = join(dir, "upload.png");
      writeFileSync(staged, "png-bytes");
      expect(
        await run({
          operation: "file-choice",
          leaseId: ids.leaseId,
          chooserId: withChooser.fileChooser.chooserId,
          paths: [staged],
        }),
      ).toEqual({ status: "file-chosen" });
      expect(resolvedFiles).toHaveBeenCalledWith([staged]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
