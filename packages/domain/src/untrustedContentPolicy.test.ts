import { describe, expect, it } from "vitest";
import {
  assertContentDoesNotAuthorize,
  emptyThreadContentTaint,
  formatTaintedApprovalPrompt,
  isIrreversibleOrAuthorityBearingApprovalClass,
  originTaintsThread,
  projectThreadContentTaint,
  resolveTaintedApproval,
  type ToolApprovalClass,
} from "./untrustedContentPolicy";

describe("originTaintsThread", () => {
  it("marks tool-result and external-content as tainting, not user or provider-text", () => {
    expect(originTaintsThread("tool-result")).toBe(true);
    expect(originTaintsThread("external-content")).toBe(true);
    expect(originTaintsThread("user")).toBe(false);
    expect(originTaintsThread("provider-text")).toBe(false);
  });
});

describe("projectThreadContentTaint", () => {
  it("derives external-content-ingested for the thread lifetime and never clears on session or turn", () => {
    let state = emptyThreadContentTaint();
    expect(state.externalContentIngested).toBe(false);

    state = projectThreadContentTaint(state, {
      kind: "content-ingested",
      provenance: { origin: "user", sourceLabel: "composer-prompt" },
    });
    expect(state.externalContentIngested).toBe(false);

    state = projectThreadContentTaint(state, {
      kind: "content-ingested",
      provenance: { origin: "external-content", sourceLabel: "readme-md" },
    });
    expect(state).toEqual({
      externalContentIngested: true,
      ingestedSources: ["readme-md"],
    });

    state = projectThreadContentTaint(state, { kind: "session-boundary" });
    state = projectThreadContentTaint(state, { kind: "turn-boundary" });
    expect(state.externalContentIngested).toBe(true);
    expect(state.ingestedSources).toEqual(["readme-md"]);

    state = projectThreadContentTaint(state, {
      kind: "content-ingested",
      provenance: { origin: "tool-result", sourceLabel: "mcp-search" },
    });
    expect(state.ingestedSources).toEqual(["readme-md", "mcp-search"]);
  });

  it("deduplicates source labels while preserving first-seen order", () => {
    let state = emptyThreadContentTaint();
    state = projectThreadContentTaint(state, {
      kind: "content-ingested",
      provenance: { origin: "tool-result", sourceLabel: "browser-1" },
    });
    state = projectThreadContentTaint(state, {
      kind: "content-ingested",
      provenance: { origin: "tool-result", sourceLabel: "browser-1" },
    });
    expect(state.ingestedSources).toEqual(["browser-1"]);
  });
});

describe("irreversible and authority-bearing approval classes", () => {
  it("identifies the design §8.4 irreversible and authority-bearing classes", () => {
    const irreversible: ReadonlyArray<ToolApprovalClass> = [
      "destructive-or-irreversible",
      "credential-or-secret-access",
      "access-outside-selected-project",
      "privilege-expansion-or-sandbox-change",
    ];
    for (const approvalClass of irreversible) {
      expect(isIrreversibleOrAuthorityBearingApprovalClass(approvalClass)).toBe(true);
    }
    for (const approvalClass of [
      "project-file-writes",
      "shell-commands",
      "network-access",
      "external-application-observation-or-control",
    ] as const) {
      expect(isIrreversibleOrAuthorityBearingApprovalClass(approvalClass)).toBe(false);
    }
  });
});

describe("resolveTaintedApproval", () => {
  it("forces fresh per-action confirmation on tainted threads despite standing Full access", () => {
    const tainted = {
      externalContentIngested: true,
      ingestedSources: ["readme-md", "mcp-search"],
    };

    expect(
      resolveTaintedApproval({
        taint: tainted,
        approvalClass: "destructive-or-irreversible",
        standingGrant: "remembered-full-access",
        freshPerActionConfirmation: false,
      }),
    ).toEqual({
      kind: "prompt",
      reason: "tainted-thread-requires-fresh-confirmation",
      prompt: formatTaintedApprovalPrompt(tainted.ingestedSources),
      ignoredStandingGrant: "remembered-full-access",
    });

    expect(
      resolveTaintedApproval({
        taint: tainted,
        approvalClass: "credential-or-secret-access",
        standingGrant: "session",
        freshPerActionConfirmation: false,
      }).kind,
    ).toBe("prompt");

    expect(
      resolveTaintedApproval({
        taint: tainted,
        approvalClass: "destructive-or-irreversible",
        standingGrant: "remembered-full-access",
        freshPerActionConfirmation: true,
      }),
    ).toEqual({ kind: "allow" });
  });

  it("does not force taint prompts for ordinary approval classes or clean threads", () => {
    expect(
      resolveTaintedApproval({
        taint: { externalContentIngested: true, ingestedSources: ["readme-md"] },
        approvalClass: "shell-commands",
        standingGrant: "session",
        freshPerActionConfirmation: false,
      }),
    ).toEqual({ kind: "allow-standing-grant" });

    expect(
      resolveTaintedApproval({
        taint: emptyThreadContentTaint(),
        approvalClass: "destructive-or-irreversible",
        standingGrant: "remembered-full-access",
        freshPerActionConfirmation: false,
      }),
    ).toEqual({ kind: "allow-standing-grant" });
  });

  it("names ingested sources in the confirmation prompt", () => {
    const prompt = formatTaintedApprovalPrompt(["readme-md", "web-fetch"]);
    expect(prompt).toContain("readme-md");
    expect(prompt).toContain("web-fetch");
    expect(prompt.toLowerCase()).toContain("external");
  });
});

describe("assertContentDoesNotAuthorize", () => {
  it("rejects parsing tool or file content into invocations, approvals, trust, or authority", () => {
    expect(() =>
      assertContentDoesNotAuthorize({
        attemptedEffect: "tool-invocation",
        contentOrigin: "tool-result",
      }),
    ).toThrow(/never/i);
    expect(() =>
      assertContentDoesNotAuthorize({
        attemptedEffect: "approval",
        contentOrigin: "external-content",
      }),
    ).toThrow(/never/i);
    expect(() =>
      assertContentDoesNotAuthorize({
        attemptedEffect: "trust-change",
        contentOrigin: "external-content",
      }),
    ).toThrow(/never/i);
    expect(() =>
      assertContentDoesNotAuthorize({
        attemptedEffect: "authority-transition",
        contentOrigin: "tool-result",
      }),
    ).toThrow(/never/i);
  });
});
