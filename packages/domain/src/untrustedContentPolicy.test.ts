import { describe, expect, it } from "vitest";
import { MAX_NAMED_INGESTED_SOURCES } from "@octant/contracts";
import {
  decideExternalContentIngestion,
  emptyThreadContentTaint,
  formatTaintedApprovalPrompt,
  isIrreversibleOrAuthorityBearingApprovalClass,
  nativeHarnessResultTaintsThread,
  originTaintsThread,
  projectThreadContentTaint,
  resolveTaintedApproval,
  searchQueryRefusalUnderTaint,
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

  it("keeps the thread tainted after the named-source summary is full", () => {
    let state = emptyThreadContentTaint();
    for (let index = 0; index < MAX_NAMED_INGESTED_SOURCES + 1; index += 1) {
      state = projectThreadContentTaint(state, {
        kind: "content-ingested",
        provenance: { origin: "tool-result", sourceLabel: `source-${index}` },
      });
    }
    expect(state.externalContentIngested).toBe(true);
    expect(state.ingestedSources).toHaveLength(MAX_NAMED_INGESTED_SOURCES);
    expect(state.ingestedSources[0]).toBe("source-0");
  });
});

describe("decideExternalContentIngestion", () => {
  it("records tainting origins once and ignores user or provider text", () => {
    expect(
      decideExternalContentIngestion({
        authorized: true,
        origin: "tool-result",
        alreadyRecorded: false,
      }),
    ).toEqual({ kind: "record" });
    expect(
      decideExternalContentIngestion({
        authorized: true,
        origin: "external-content",
        alreadyRecorded: true,
      }),
    ).toEqual({ kind: "already-recorded" });
    expect(
      decideExternalContentIngestion({
        authorized: true,
        origin: "user",
        alreadyRecorded: false,
      }),
    ).toEqual({ kind: "ignore", reason: "not-tainting" });
  });

  it("refuses unauthorized callers without treating them as a clean ignore", () => {
    expect(
      decideExternalContentIngestion({
        authorized: false,
        origin: "tool-result",
        alreadyRecorded: false,
      }),
    ).toEqual({ kind: "refuse", reason: "unauthorized" });
    expect(
      decideExternalContentIngestion({
        authorized: false,
        origin: "user",
        alreadyRecorded: false,
      }),
    ).toEqual({ kind: "refuse", reason: "unauthorized" });
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

describe("nativeHarnessResultTaintsThread", () => {
  it("taints only for a harness tool that brings in outside content", () => {
    const taints = (toolName: string, args: unknown = {}, result: unknown = {}) =>
      nativeHarnessResultTaintsThread({ toolName, arguments: args, result });
    for (const local of [
      "read",
      "grep",
      "glob",
      "bash",
      "edit",
      "write",
      "goal-check",
      "todo-write",
    ])
      expect(taints(local)).toBe(false);
    expect(taints("web-fetch")).toBe(true);
    expect(taints("web-search")).toBe(true);
    // A child's collected reply may relay what the child fetched; its status,
    // or a collect that finds it still running, does not.
    expect(
      taints(
        "delegate",
        { operation: "collect", runId: "run-1" },
        { status: "completed", text: "done", truncated: false },
      ),
    ).toBe(true);
    expect(
      taints(
        "delegate",
        { operation: "collect", runId: "run-1" },
        { status: "not-ready", lifecycleStatus: "running" },
      ),
    ).toBe(false);
    expect(taints("delegate", { operation: "status" })).toBe(false);
    // A tool the catalog does not know fails closed.
    expect(taints("harness-teleport")).toBe(true);
  });
});

describe("searchQueryRefusalUnderTaint", () => {
  it("names why a query that looks like it carries data is refused", () => {
    const refusals: ReadonlyArray<readonly [string, string]> = [
      ["docs at https://example.com/setup", "contains a URL"],
      ["status of http://10.0.0.4:8080", "contains a URL"],
      ["see www.example.org for details", "contains a URL"],
      ["attacker.example/collect?d=hunter2", "contains a URL"],
      ["10.1.2.3:5432/prod", "contains a URL"],
      ["attacker.example:8080/collect?d=hunter2", "contains a URL"],
      ["leak.example.com./collect?d=hunter2", "contains a URL"],
      ["leak.example.xn--p1ai/collect?d=hunter2", "contains a URL"],
      ["contact jane.doe@corp.example about billing", "contains an email address"],
      ["token sk-ant-api03-Zx9Qw7Lm2Np4Rt", "contains a long high-entropy token"],
      ["key AKIAIOSFODNN7EXAMPLE leaked", "contains a long high-entropy token"],
      ["aGVsbG8gd29ybGQsIHRoaXMgaXMgc2VjcmV0", "contains a base64 run"],
      ["cGFzc3dvcmQ6aHVudGVyMg== meaning", "contains a base64 run"],
      ["commit 9fceb02d0ae598e95dc970b74767f19372d61af8", "contains a hex run"],
      ["card 4111111111111111 expiry", "contains a hex run"],
      ["lookup %68%75%6E%74%65%72%32", "contains a percent-encoded run"],
      ["lookup \\x68\\x75\\x6e\\x74", "contains a percent-encoded run"],
      [`how do I ${"configure bun workspaces and ".repeat(8)}`, "is longer than 200 characters"],
    ];
    for (const [query, detail] of refusals) {
      expect(searchQueryRefusalUnderTaint(query), query).toEqual({
        reason: "search-query-refused-under-taint",
        detail,
      });
    }
  });

  it("lets ordinary questions through", () => {
    for (const query of [
      "how do I configure bun workspaces",
      "error TS2322 in vitest",
      "react 19.2 release notes",
      "node 22.11.0 changelog",
      "electron 38 macOS notarization",
      "ERR_PACKAGE_PATH_NOT_EXPORTED vite",
      "@typescript-eslint/no-unused-vars ignore pattern",
      "UserProfileController.test.ts mock not called",
      "MyComponent.test.tsx:42 act warning",
      "git commit 9fceb02 revert",
      "useLayoutEffect vs useEffect",
      "Effect.Schema decodeUnknownSync exactOptionalPropertyTypes",
      "what is the weather in Oslo tomorrow",
      "TypeError: Cannot read properties of undefined (reading 'map')",
      "C# string interpolation",
      "C%23 string interpolation",
      "x".repeat(200),
    ]) {
      expect(searchQueryRefusalUnderTaint(query), query).toBeUndefined();
    }
  });
});
