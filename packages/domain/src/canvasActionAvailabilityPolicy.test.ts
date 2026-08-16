import { describe, expect, it } from "vitest";
import {
  decodeCanvasActionBlock,
  type CanvasActionBlock,
  type CanvasActionDenialCode,
} from "@octant/contracts/canvas-actions";
import {
  canvasActionEffectLabel,
  evaluateCanvasActionAvailability,
  safeCanvasActionDenialReason,
} from "./canvasActionAvailabilityPolicy";

const ids = {
  source: "44444444-4444-4444-8444-444444444444",
} as const;

function readBlock(): CanvasActionBlock {
  return decodeCanvasActionBlock({
    schemaVersion: 1,
    blockId: "action-open",
    kind: "action",
    label: "Open source",
    command: { command: "canvas.open-source", sourceId: ids.source },
  });
}

function mutateBlock(): CanvasActionBlock {
  return decodeCanvasActionBlock({
    schemaVersion: 1,
    blockId: "action-propose",
    kind: "action",
    label: "Propose a thread",
    command: { command: "canvas.propose-thread", prompt: "Investigate the spike" },
  });
}

const ALL_DENIAL_CODES: readonly CanvasActionDenialCode[] = [
  "malformed-request",
  "unavailable",
  "unauthorized",
  "scope-mismatch",
  "mode-mismatch",
  "origin-thread-mismatch",
  "stale-version",
  "revoked",
  "unknown-command",
  "unsupported-schema",
  "approval-required",
  "approval-denied",
  "cancelled",
];

describe("safeCanvasActionDenialReason", () => {
  it("maps every denial code to non-empty, bounded copy", () => {
    for (const code of ALL_DENIAL_CODES) {
      const reason = safeCanvasActionDenialReason(code);
      expect(reason.length).toBeGreaterThan(0);
      expect(reason.length).toBeLessThanOrEqual(120);
    }
  });

  it("never leaks provenance metadata in any reason", () => {
    // A safe reason must never echo host paths, identifiers, credentials, raw
    // command ids, or scheme-bearing references.
    const forbidden = [
      "/",
      "\\",
      "http",
      "opaque:",
      "ref:",
      "canvas.",
      "provider",
      "token",
      "sha256",
      "@",
    ];
    for (const code of ALL_DENIAL_CODES) {
      const reason = safeCanvasActionDenialReason(code).toLowerCase();
      for (const needle of forbidden) {
        expect(reason).not.toContain(needle);
      }
    }
  });

  it("does not surface hyphenated raw denial codes to the reader", () => {
    // Hyphenated identifiers (e.g. `scope-mismatch`, `stale-version`) are wire
    // codes; a reader must never see them. Single dictionary words such as
    // "cancelled" are legitimate prose and intentionally allowed.
    for (const code of ALL_DENIAL_CODES) {
      if (code.includes("-")) {
        expect(safeCanvasActionDenialReason(code)).not.toContain(code);
      }
    }
  });
});

describe("canvasActionEffectLabel", () => {
  it("differentiates read-only from mutating commands with words, not color", () => {
    const capability = {
      command: "canvas.open-source",
      effect: "read",
      requiresApproval: false,
    } as const;
    expect(canvasActionEffectLabel(capability)).toBe("Read-only");
    const mutating = {
      command: "canvas.propose-thread",
      effect: "mutate",
      requiresApproval: true,
    } as const;
    expect(canvasActionEffectLabel(mutating)).toBe("Changes your workspace");
  });
});

describe("evaluateCanvasActionAvailability", () => {
  it("offers a read-only action in a dispatch-capable session", () => {
    const availability = evaluateCanvasActionAvailability(readBlock(), {
      mode: "chat",
      canExecuteActions: true,
    });
    expect(availability.state).toBe("available");
    expect(availability.capability.effect).toBe("read");
    expect(availability.requiresApproval).toBe(false);
    expect(availability.reason).toBeUndefined();
  });

  it("reports the approval gate for a mutating command without disabling it", () => {
    const availability = evaluateCanvasActionAvailability(mutateBlock(), {
      mode: "chat",
      canExecuteActions: true,
    });
    expect(availability.state).toBe("available");
    expect(availability.capability.effect).toBe("mutate");
    expect(availability.requiresApproval).toBe(true);
  });

  it("fails closed to unavailable when the session cannot dispatch actions", () => {
    const availability = evaluateCanvasActionAvailability(readBlock(), {
      mode: "chat",
      canExecuteActions: false,
    });
    expect(availability.state).toBe("unavailable");
    expect(availability.reason).toBe(safeCanvasActionDenialReason("unavailable"));
  });

  it("disables an action the host reports unavailable", () => {
    const availability = evaluateCanvasActionAvailability(readBlock(), {
      mode: "chat",
      canExecuteActions: true,
      available: false,
    });
    expect(availability.state).toBe("unavailable");
    expect(availability.reason).toBe(safeCanvasActionDenialReason("unavailable"));
  });

  it("disables an action the host reports unauthorized, taking precedence", () => {
    const availability = evaluateCanvasActionAvailability(readBlock(), {
      mode: "chat",
      canExecuteActions: false,
      authorized: false,
      available: false,
    });
    expect(availability.state).toBe("unauthorized");
    expect(availability.reason).toBe(safeCanvasActionDenialReason("unauthorized"));
  });
});
