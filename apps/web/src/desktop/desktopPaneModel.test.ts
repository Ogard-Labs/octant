import { decodeDesktopLease } from "@octant/contracts";
import { describe, expect, it } from "vitest";
import {
  desktopKeyIntent,
  desktopPaneState,
  endedMessage,
  screenPoint,
  type DesktopOverview,
} from "./desktopPaneModel";

const ready = decodeDesktopLease({
  leaseId: "81000000-0000-4000-8000-000000000001",
  owner: { mode: "code", threadId: "81000000-0000-4000-8000-000000000002" },
  providerId: "host-local",
  locality: "host-local",
  billed: false,
  state: "ready",
  requestedAt: "2026-10-27T12:00:00.000Z",
  expiresAt: "2026-10-27T12:30:00.000Z",
  maximumExpiresAt: "2026-10-27T16:00:00.000Z",
  idleMinutes: 15,
  updatedAt: "2026-10-27T12:00:00.000Z",
});
const overview: DesktopOverview = {
  status: "overview",
  leases: [ready],
  providers: [],
  start: { status: "refused", reason: "lease-limit" },
};
const key = (key: string, extra: Partial<Record<"ctrlKey" | "metaKey" | "altKey", boolean>> = {}) =>
  desktopKeyIntent({
    key,
    type: "keydown",
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    ...extra,
  });

describe("desktop pane model", () => {
  it("shows a running desktop only to a tab that opened a view of it in this session", () => {
    expect(desktopPaneState({ overview, acquiring: false, view: "none" }).kind).toBe("not-shown");
    expect(desktopPaneState({ overview, acquiring: false, view: "open" }).kind).toBe("live");
    expect(desktopPaneState({ overview, acquiring: false, view: "lost" }).kind).toBe("interrupted");
  });

  it("says a key gone from the credential store is why a desktop did not start", () => {
    const refused = { ...ready, state: "refused" } as const;
    expect(endedMessage(refused)).toBe("The desktop could not be started.");
    expect(endedMessage({ ...refused, credentialMissing: true })).toMatch(
      /key saved for it is no longer in this computer's credential store/,
    );
  });

  it("types printable characters as text and sends named keys, and never sends Mod+Escape", () => {
    expect(key("é")).toEqual({ kind: "text", text: "é" });
    expect(key("Enter")).toEqual({
      kind: "key",
      event: { kind: "key", action: "down", key: "Enter" },
    });
    expect(key("c", { ctrlKey: true })).toEqual({
      kind: "key",
      event: { kind: "key", action: "down", key: "c" },
    });
    expect(key("Escape", { metaKey: true })).toEqual({ kind: "leave" });
  });

  it("maps a point on the shown picture to the desktop's pixels and refuses one off it", () => {
    const shown = { left: 10, top: 10, width: 640, height: 400 };
    expect(screenPoint({ x: 330, y: 210 }, shown, { width: 1280, height: 800 })).toEqual({
      x: 640,
      y: 400,
    });
    expect(screenPoint({ x: 5, y: 210 }, shown, { width: 1280, height: 800 })).toBeUndefined();
  });
});
