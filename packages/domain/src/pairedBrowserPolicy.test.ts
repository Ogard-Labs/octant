import { describe, expect, it } from "vitest";
import {
  MAX_PAIRED_BROWSER_EVENTS_PER_SECOND,
  MAX_PAIRED_BROWSER_LEASES_PER_HOST,
  MAX_PAIRED_BROWSER_TEXT_CHARS_PER_MINUTE,
} from "@octant/contracts/paired-browser-control";
import {
  countPairedBrowserTypedChars,
  decidePairedBrowserPrincipal,
  decidePairedBrowserTakeOver,
  evaluatePairedBrowserFrameTarget,
  evaluatePairedBrowserInputRate,
  evaluatePairedBrowserSequence,
  isForbiddenPairedBrowserKey,
} from "./pairedBrowserPolicy";

describe("paired browser hold policy", () => {
  it("admits only a person-paired device and refuses hub-introduced devices and agent grants", () => {
    expect(decidePairedBrowserPrincipal({ principalKind: "person-paired-device" })).toEqual({
      status: "allowed",
    });
    expect(decidePairedBrowserPrincipal({ principalKind: "remote-device" })).toEqual({
      status: "refused",
      reason: "remote-control-not-person",
    });
    expect(
      decidePairedBrowserPrincipal({ principalKind: "person-paired-device", isAgentGrant: true }),
    ).toEqual({
      status: "refused",
      reason: "remote-control-not-person",
    });
    expect(decidePairedBrowserPrincipal({ principalKind: "local-window" })).toEqual({
      status: "refused",
      reason: "remote-control-not-person",
    });
  });

  it("enforces one controller per page, one page per device, and at most four leases per host", () => {
    const base = {
      principalKind: "person-paired-device" as const,
      pagePresent: true,
      authorityCurrent: true,
      pageHeldByAnother: false,
      deviceHoldsAnotherPage: false,
      activeHostLeaseCount: 0,
    };
    expect(decidePairedBrowserTakeOver(base)).toEqual({ status: "allowed" });
    expect(decidePairedBrowserTakeOver({ ...base, pagePresent: false })).toEqual({
      status: "refused",
      reason: "page-not-here",
    });
    expect(decidePairedBrowserTakeOver({ ...base, authorityCurrent: false })).toEqual({
      status: "refused",
      reason: "authority-ended",
    });
    expect(decidePairedBrowserTakeOver({ ...base, pageHeldByAnother: true })).toEqual({
      status: "refused",
      reason: "browser-page-held-elsewhere",
    });
    expect(decidePairedBrowserTakeOver({ ...base, deviceHoldsAnotherPage: true })).toEqual({
      status: "refused",
      reason: "browser-page-held-elsewhere",
    });
    expect(
      decidePairedBrowserTakeOver({
        ...base,
        activeHostLeaseCount: MAX_PAIRED_BROWSER_LEASES_PER_HOST,
      }),
    ).toMatchObject({ status: "refused", reason: "rate-limited" });
  });

  it("refuses host window and shell shortcuts while admitting normal page keys", () => {
    expect(isForbiddenPairedBrowserKey({ key: "q", code: "KeyQ", modifiers: { meta: true } })).toBe(
      true,
    );
    expect(isForbiddenPairedBrowserKey({ key: "w", code: "KeyW", modifiers: { meta: true } })).toBe(
      true,
    );
    expect(isForbiddenPairedBrowserKey({ key: "l", code: "KeyL", modifiers: { meta: true } })).toBe(
      true,
    );
    expect(
      isForbiddenPairedBrowserKey({ key: "i", code: "KeyI", modifiers: { meta: true, alt: true } }),
    ).toBe(true);
    expect(isForbiddenPairedBrowserKey({ key: "F12", code: "F12" })).toBe(true);
    expect(isForbiddenPairedBrowserKey({ key: "k", code: "KeyK", modifiers: { meta: true } })).toBe(
      true,
    );
    expect(
      isForbiddenPairedBrowserKey({ key: "Enter", code: "Enter", modifiers: { shift: true } }),
    ).toBe(false);
    expect(isForbiddenPairedBrowserKey({ key: "a", code: "KeyA" })).toBe(false);
  });

  it("refuses requests past event-per-second or typed-character-per-minute limits", () => {
    const tap = { kind: "tap", frameId: 2, x: 0.5, y: 0.5 } as const;
    expect(
      evaluatePairedBrowserInputRate({
        events: [tap],
        window: { eventsInLastSecond: MAX_PAIRED_BROWSER_EVENTS_PER_SECOND, charsInLastMinute: 0 },
      }),
    ).toMatchObject({ status: "refused", reason: "rate-limited" });
    expect(
      countPairedBrowserTypedChars([
        { kind: "text", text: "abc" },
        { kind: "composition", phase: "commit", text: "de" },
      ]),
    ).toBe(5);
    expect(
      evaluatePairedBrowserInputRate({
        events: [{ kind: "text", text: "abcd" }],
        window: {
          eventsInLastSecond: 0,
          charsInLastMinute: MAX_PAIRED_BROWSER_TEXT_CHARS_PER_MINUTE - 2,
        },
      }),
    ).toMatchObject({ status: "refused", reason: "rate-limited" });
  });

  it("rejects duplicate sequence numbers and pointer events aimed at stale frames", () => {
    expect(evaluatePairedBrowserSequence({ sequence: 2, lastAcceptedSequence: 1 })).toEqual({
      status: "allowed",
    });
    expect(evaluatePairedBrowserSequence({ sequence: 2, lastAcceptedSequence: 2 })).toEqual({
      status: "refused",
      reason: "stale-frame",
    });
    expect(
      evaluatePairedBrowserFrameTarget({
        events: [{ kind: "tap", frameId: 3, x: 0.5, y: 0.5 }],
        minValidFrameId: 4,
        latestFrameId: 5,
      }),
    ).toEqual({ status: "refused", reason: "stale-frame" });
    expect(
      evaluatePairedBrowserFrameTarget({
        events: [{ kind: "tap", frameId: 4, x: 0.5, y: 0.5 }],
        minValidFrameId: 4,
        latestFrameId: 5,
      }),
    ).toEqual({ status: "allowed" });
    expect(
      evaluatePairedBrowserFrameTarget({
        events: [{ kind: "text", text: "ok" }],
        minValidFrameId: 4,
        latestFrameId: 5,
      }),
    ).toEqual({ status: "allowed" });
  });
});
