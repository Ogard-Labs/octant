import { describe, expect, it } from "vitest";
import {
  MAX_PAIRED_BROWSER_EVENTS_PER_REQUEST,
  MAX_PAIRED_BROWSER_FRAME_HEIGHT,
  MAX_PAIRED_BROWSER_FRAME_WIDTH,
  MAX_PAIRED_BROWSER_TEXT_LENGTH,
  decodePairedBrowserHoldEndedPayload,
  decodePairedBrowserHoldStartedPayload,
  decodePairedBrowserInput,
  decodePairedBrowserNativeCommand,
  decodePairedBrowserNativeResult,
  decodePairedBrowserRequest,
  decodePairedBrowserResponse,
  decodePairedBrowserStreamEvent,
} from "./pairedBrowserControl";

const ids = {
  threadId: "11111111-1111-4111-8111-111111111111",
  contextId: "22222222-2222-4222-8222-222222222222",
  leaseId: "33333333-3333-4333-8333-333333333333",
  chooserId: "44444444-4444-4444-8444-444444444444",
  uploadId: "55555555-5555-4555-8555-555555555555",
  windowId: "66666666-6666-4666-8666-666666666666",
  documentVersion: "a".repeat(64),
};

describe("paired browser control contracts", () => {
  it("accepts only the closed touch, scroll, key, text, and IME input events", () => {
    expect(decodePairedBrowserInput({ kind: "tap", frameId: 1, x: 0.5, y: 0.25 })).toMatchObject({
      kind: "tap",
      frameId: 1,
    });
    expect(
      decodePairedBrowserInput({ kind: "long-press", frameId: 2, x: 0.1, y: 0.9, durationMs: 600 }),
    ).toMatchObject({ kind: "long-press", durationMs: 600 });
    expect(
      decodePairedBrowserInput({
        kind: "drag",
        frameId: 3,
        points: [
          { x: 0.2, y: 0.2 },
          { x: 0.5, y: 0.5 },
          { x: 0.8, y: 0.8 },
        ],
      }),
    ).toMatchObject({ kind: "drag" });
    expect(
      decodePairedBrowserInput({
        kind: "scroll",
        frameId: 4,
        x: 0.5,
        y: 0.5,
        deltaX: 0,
        deltaY: 240,
      }),
    ).toMatchObject({ kind: "scroll" });
    expect(
      decodePairedBrowserInput({
        kind: "key",
        phase: "down",
        key: "Enter",
        code: "Enter",
        modifiers: { shift: true },
      }),
    ).toMatchObject({ kind: "key", phase: "down" });
    expect(decodePairedBrowserInput({ kind: "text", text: "hello" })).toEqual({
      kind: "text",
      text: "hello",
    });
    expect(
      decodePairedBrowserInput({ kind: "composition", phase: "update", text: "nihon" }),
    ).toEqual({
      kind: "composition",
      phase: "update",
      text: "nihon",
    });

    for (const forbidden of [
      { kind: "mouse", x: 0.5, y: 0.5 },
      { kind: "click", frameId: 1, x: 0.5, y: 0.5, button: "right" },
      { kind: "hover", frameId: 1, x: 0.5, y: 0.5 },
      { kind: "navigate", url: "https://example.com" },
      { kind: "script", source: "document.cookie" },
      { kind: "clipboard-read" },
      { kind: "tap", x: 0.5, y: 0.5 },
      { kind: "text", text: "x".repeat(MAX_PAIRED_BROWSER_TEXT_LENGTH + 1) },
      { kind: "tap", frameId: 1, x: 1.2, y: 0.5 },
    ]) {
      expect(() => decodePairedBrowserInput(forbidden)).toThrow();
    }
  });

  it("bounds input batches to 1..60 events and rejects excess request properties", () => {
    const tap = { kind: "tap", frameId: 1, x: 0.5, y: 0.5 } as const;
    expect(
      decodePairedBrowserRequest({
        kind: "input",
        leaseId: ids.leaseId,
        sequence: 1,
        events: [tap],
      }),
    ).toMatchObject({ kind: "input", sequence: 1 });
    expect(() =>
      decodePairedBrowserRequest({
        kind: "input",
        leaseId: ids.leaseId,
        sequence: 1,
        events: [],
      }),
    ).toThrow();
    expect(() =>
      decodePairedBrowserRequest({
        kind: "input",
        leaseId: ids.leaseId,
        sequence: 1,
        events: Array.from({ length: MAX_PAIRED_BROWSER_EVENTS_PER_REQUEST + 1 }, () => tap),
      }),
    ).toThrow();
    expect(() =>
      decodePairedBrowserRequest({
        kind: "hand-back",
        leaseId: ids.leaseId,
        extra: true,
      }),
    ).toThrow();
  });

  it("decodes stream events, refusals, native broker commands, and metadata-only journal records", () => {
    expect(
      decodePairedBrowserStreamEvent({
        kind: "frame",
        frameId: 7,
        documentVersion: ids.documentVersion,
        viewport: {
          width: MAX_PAIRED_BROWSER_FRAME_WIDTH,
          height: MAX_PAIRED_BROWSER_FRAME_HEIGHT,
        },
        devicePixelRatio: 2,
        jpegBase64: "AAAA",
      }),
    ).toMatchObject({ kind: "frame", frameId: 7 });
    expect(() =>
      decodePairedBrowserStreamEvent({
        kind: "frame",
        frameId: 7,
        documentVersion: ids.documentVersion,
        viewport: { width: MAX_PAIRED_BROWSER_FRAME_WIDTH + 1, height: 600 },
        devicePixelRatio: 1,
        jpegBase64: "AAAA",
      }),
    ).toThrow();
    expect(decodePairedBrowserStreamEvent({ kind: "withheld", reason: "private-custody" })).toEqual(
      { kind: "withheld", reason: "private-custody" },
    );
    expect(
      decodePairedBrowserStreamEvent({
        kind: "file-chooser",
        chooserId: ids.chooserId,
        accept: ["image/png"],
        multiple: false,
      }),
    ).toMatchObject({ kind: "file-chooser", multiple: false });
    expect(
      decodePairedBrowserResponse({ status: "refused", reason: "remote-control-not-person" }),
    ).toEqual({ status: "refused", reason: "remote-control-not-person" });
    expect(
      decodePairedBrowserNativeCommand({
        operation: "release",
        contextId: ids.contextId,
        owner: { windowId: ids.windowId, threadId: ids.threadId },
        leaseId: ids.leaseId,
        disposition: "hand-back",
      }),
    ).toMatchObject({ operation: "release", disposition: "hand-back" });
    expect(
      decodePairedBrowserNativeResult({ status: "withheld", reason: "native-prompt" }),
    ).toEqual({ status: "withheld", reason: "native-prompt" });
    expect(
      decodePairedBrowserHoldStartedPayload({
        threadId: ids.threadId,
        contextId: ids.contextId,
        tabId: "tab-1",
        profileKind: "personal",
        origin: "https://example.com",
        leaseId: ids.leaseId,
      }),
    ).toMatchObject({ profileKind: "personal" });
    expect(
      decodePairedBrowserHoldEndedPayload({
        threadId: ids.threadId,
        contextId: ids.contextId,
        tabId: "tab-1",
        profileKind: "personal",
        origin: "https://example.com",
        leaseId: ids.leaseId,
        endReason: "reclaimed-locally",
        eventCount: 12,
        frameCount: 30,
      }),
    ).toMatchObject({ endReason: "reclaimed-locally", eventCount: 12, frameCount: 30 });
  });
});
