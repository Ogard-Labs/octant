import { describe, expect, it } from "vitest";
import { contextFixture } from "./contextFixtures";
import {
  autoCompactRoom,
  contextCompositionEntries,
  contextCategoryTone,
  contextEntryControls,
  contextStatusModel,
  contextWindowModel,
  contextWindowUsedSourceLabel,
  providerWindowModel,
  serviceLimitLabel,
  tokenMeasurementLabel,
} from "./contextInspectorModel";

describe("context inspector presentation model", () => {
  it.each(["healthy", "watch", "optimizing", "action-needed", "blocked", "rate-limited"] as const)(
    "represents %s with a non-color label",
    (health) => {
      expect(contextStatusModel(contextFixture({ health }), { kind: "thread" })).toMatchObject({
        health,
        healthLabel: expect.any(String),
        scopeLabel: "Fixture thread · model-a",
      });
    },
  );

  it("does not present unknown tokens as exact", () => {
    const fixture = contextFixture({ unknownTokens: true });
    expect(contextStatusModel(fixture, { kind: "thread" }).usageLabel).toContain("unknown");
    expect(tokenMeasurementLabel(fixture.next.manifest.entries[1]!.tokens)).toBe("Unknown");
    expect(
      contextWindowModel({ ...fixture, latestSent: undefined, latestUsage: undefined }).usedSource,
    ).toBe("unknown");
  });

  it("marks model-family estimates on the category they came from", () => {
    const tools = contextWindowModel(contextFixture()).segments.find(
      (segment) => segment.label === "Octant tools",
    );
    expect(tools).toMatchObject({ estimated: true, tokens: 58 });
    const request = contextWindowModel(contextFixture()).segments.find(
      (segment) => segment.label === "Current request",
    );
    expect(request?.estimated).toBeUndefined();
  });

  it("labels last-sent usage as provider reported when the host reconciled it", () => {
    expect(contextWindowModel(contextFixture()).usedSource).toBe("provider-reported");
    expect(contextWindowUsedSourceLabel("provider-reported")).toBe("Provider reported");
  });

  it("uses the reported window occupancy and capacity instead of cumulative usage and fallback limits", () => {
    const fixture = contextFixture();
    if (fixture.latestUsage === undefined) throw new Error("Fixture has no usage");
    const model = contextWindowModel({
      ...fixture,
      latestUsage: {
        ...fixture.latestUsage,
        actualInputTokens: 29_800,
        contextTokens: 12_000,
        contextWindow: 200_000,
      },
    });
    expect(model).toMatchObject({ usedTokens: 12_000, totalTokens: 200_000, percent: 6 });
  });

  describe("a window nothing named", () => {
    function unnamedWindow(contextWindow?: number) {
      const fixture = contextFixture();
      if (fixture.latestUsage === undefined) throw new Error("Fixture has no usage");
      return {
        ...fixture,
        modelLimits: {
          ...fixture.modelLimits,
          contextWindow: 4_096,
          source: "conservative-fallback" as const,
          confidence: "low" as const,
        },
        latestUsage: {
          ...fixture.latestUsage,
          actualInputTokens: 34_300,
          contextTokens: 34_300,
          ...(contextWindow === undefined ? {} : { contextWindow }),
        },
      };
    }

    it("shows the fill alone, with no fraction, share, or free room, after a turn", () => {
      const model = contextWindowModel(unnamedWindow());
      expect(model.usageLabel).toBe("34.3K");
      expect(model.usedTokens).toBe(34_300);
      expect(model).not.toHaveProperty("totalTokens");
      expect(model).not.toHaveProperty("percent");
      expect(model.segments.some((segment) => segment.kind === "free")).toBe(false);
      expect(model.segments.every((segment) => segment.percent === undefined)).toBe(true);
    });

    it("shows the fill alone before the first turn", () => {
      const model = contextWindowModel({
        ...unnamedWindow(),
        latestSent: undefined,
        latestUsage: undefined,
      });
      expect(model.sourceLabel).toBe("Next turn");
      expect(model.usageLabel).toBe("100");
      expect(model).not.toHaveProperty("percent");
    });

    it("takes the window from the provider's own report when it names one", () => {
      expect(contextWindowModel(unnamedWindow(258_000))).toMatchObject({
        usageLabel: "34.3K / 258K",
        totalTokens: 258_000,
        percent: 13.3,
      });
    });

    it("does not divide the planned input by the estimate in the status line", () => {
      expect(contextStatusModel(unnamedWindow(), { kind: "thread" }).usageLabel).toBe(
        "Context 100 estimated",
      );
    });
  });

  it("keeps pane focus explicit while preserving thread attention", () => {
    expect(
      contextStatusModel(contextFixture({ health: "blocked" }), {
        kind: "pane",
        label: "Terminal",
      }),
    ).toMatchObject({ scopeLabel: "Terminal", attentionLabel: "Fixture thread: Blocked" });
  });

  it("calls unavailable limits unavailable instead of unlimited", () => {
    expect(serviceLimitLabel({ status: "unavailable" })).toBe("Unavailable");
  });

  it("prevents protected exclusions and ineligible pins in the view model", () => {
    const fixture = contextFixture();
    expect(contextEntryControls(fixture.next.manifest.entries[0]!, fixture)).toMatchObject({
      canExclude: false,
      canPin: true,
    });
    const ineligible = {
      ...fixture.next.manifest.entries[1]!,
      eligibility: {
        providerInstanceId: fixture.modelLimits.providerInstanceId,
        status: "ineligible" as const,
        reason: "authority-denied" as const,
      },
      state: "omitted" as const,
      includedSize: 0,
    };
    expect(contextEntryControls(ineligible, fixture)).toMatchObject({ canPin: false });
  });

  it("joins manifest metadata to authoritative planned state, reason, and tokens", () => {
    const fixture = contextFixture({ plannedReduction: true });
    const optional = contextCompositionEntries(fixture)[1]!;
    expect(optional).toMatchObject({
      label: "Repository search",
      plannedState: "truncated",
      planReason: "truncated",
      plannedTokens: {
        kind: "known",
        tokens: 21,
        accuracy: "conservative-heuristic",
      },
    });
    expect(optional.manifestState).toBe("included");
  });

  it("keeps omitted plan entries out of the visible context composition", () => {
    const fixture = contextFixture();
    const latestSent = fixture.latestSent;
    const latestUsage = fixture.latestUsage;
    if (latestSent === undefined || latestUsage === undefined)
      throw new Error("Fixture is incomplete");
    const optional = latestSent.plan.entries[1];
    const required = latestSent.plan.entries[0];
    if (required === undefined || optional === undefined) {
      throw new Error("Fixture is missing a planned entry");
    }
    const omitted = {
      ...fixture,
      latestSent: {
        ...latestSent,
        plan: {
          ...latestSent.plan,
          plannedInputTokens: 42,
          entries: [
            required,
            { ...optional, state: "omitted" as const, reason: "omitted-to-fit" as const },
          ],
        },
      },
      latestUsage: { ...latestUsage, actualInputTokens: 42, varianceTokens: 0 },
    };

    const model = contextWindowModel(omitted);
    expect(model.segments.find((segment) => segment.label === "Current request")).toMatchObject({
      tokens: 42,
    });
    expect(model.segments.some((segment) => segment.label === "Octant tools")).toBe(false);
  });
});

describe("room before auto-compact", () => {
  it("is the threshold less the occupancy for a runtime that compacts automatically", () => {
    expect(
      autoCompactRoom({ compaction: "automatic", thresholdTokens: 167_000, usedTokens: 120_000 }),
    ).toEqual({ tokens: 47_000 });
  });

  it("never goes below none once the session is at or past the threshold", () => {
    expect(
      autoCompactRoom({ compaction: "automatic", thresholdTokens: 167_000, usedTokens: 170_000 }),
    ).toEqual({ tokens: 0 });
  });

  it.each(["manual", "none", "unknown"] as const)(
    "shows nothing for %s compaction even when a threshold is known",
    (compaction) => {
      expect(
        autoCompactRoom({ compaction, thresholdTokens: 167_000, usedTokens: 120_000 }),
      ).toBeUndefined();
    },
  );

  it.each([
    { thresholdTokens: undefined, usedTokens: 120_000 },
    { thresholdTokens: 167_000, usedTokens: undefined },
    { thresholdTokens: 0, usedTokens: 120_000 },
    { thresholdTokens: 167_000, usedTokens: -1 },
    { thresholdTokens: Number.NaN, usedTokens: 120_000 },
  ])("shows nothing without a usable threshold and occupancy: %o", (input) => {
    expect(autoCompactRoom({ compaction: "automatic", ...input })).toBeUndefined();
  });
});

describe("window of a provider-run thread", () => {
  const sum = (segments: ReadonlyArray<{ readonly tokens?: number }>) =>
    segments.reduce((total, segment) => total + (segment.tokens ?? 0), 0);

  // What Claude Code 2.1.287 reported for a session, as the host maps it: the
  // runtime's own categories, each provider reported.
  const claude = {
    parts: [
      { kind: "system-prompt", tokens: 142, accuracy: "provider-reported" },
      { kind: "system-tools", tokens: 17_946, accuracy: "provider-reported" },
      { kind: "mcp-tools", tokens: 900, accuracy: "provider-reported", count: 12 },
      { kind: "memory-files", tokens: 16_270, accuracy: "provider-reported", count: 4 },
      { kind: "skills", tokens: 2_511, accuracy: "provider-reported", count: 17 },
      { kind: "messages", tokens: 10, accuracy: "provider-reported" },
      { kind: "reserved", tokens: 33_000, accuracy: "provider-reported" },
    ],
    deferred: [
      { kind: "system-tools", count: 25 },
      { kind: "mcp-tools", count: 30 },
    ],
  } as const;

  it("shows the categories a runtime reports, marked provider reported, with the window adding up", () => {
    const model = providerWindowModel({
      breakdown: claude,
      usedTokens: 38_000,
      windowTokens: 1_000_000,
    });

    expect(model.segments.map((segment) => segment.label)).toEqual([
      "System prompt",
      "System tools",
      "MCP tools",
      "Memory files",
      "Skills",
      "Messages",
      "Other (provider)",
      "Reserved",
      "Free space",
    ]);
    expect(
      model.segments.filter((segment) => segment.kind === "content").map((s) => s.accuracy),
    ).toEqual(Array(6).fill("provider-reported"));
    // Every token of the window is somewhere: parts, the remainder of what was
    // reported, reserved room, and free space.
    expect(sum(model.segments)).toBe(1_000_000);
    expect(model.segments.find((s) => s.key === "other-provider")).toMatchObject({
      tokens: 38_000 - (142 + 17_946 + 900 + 16_270 + 2_511 + 10),
      accuracy: "provider-reported",
    });
    expect(model.estimatedAccuracies).toEqual([]);
    expect(model.segments.some((segment) => segment.estimated === true)).toBe(false);
  });

  it("counts loaded things and shows deferred tools as such, with no share of the window", () => {
    const model = providerWindowModel({
      breakdown: claude,
      usedTokens: 38_000,
      windowTokens: 1_000_000,
    });

    expect(model.counts).toEqual([
      { key: "tools", label: "Tools", deferred: { count: 25 } },
      { key: "mcp", label: "MCP", loaded: 12, deferred: { count: 30 } },
      { key: "memory-files", label: "Memory files", loaded: 4 },
      { key: "skills", label: "Skills", loaded: 17 },
    ]);
    expect(model.segments.map((segment) => segment.label).join()).not.toContain("deferred");
  });

  it("names Octant's own count as an estimate with its accuracy and keeps the rest as Other (provider)", () => {
    const model = providerWindowModel({
      breakdown: {
        parts: [
          { kind: "octant-tools", tokens: 1_200, accuracy: "conservative-heuristic", count: 9 },
        ],
      },
      usedTokens: 20_000,
      windowTokens: 200_000,
    });

    expect(model.segments.map((segment) => segment.label)).toEqual([
      "Octant tools",
      "Other (provider)",
      "Free space",
    ]);
    expect(model.segments[0]).toMatchObject({
      tokens: 1_200,
      estimated: true,
      accuracy: "conservative-heuristic",
    });
    // What is left of a reported figure after an estimate is itself inexact, so
    // the remainder is never presented as the provider's own count.
    expect(model.segments[1]).toMatchObject({ tokens: 18_800, estimated: true });
    expect(model.segments[1]).not.toHaveProperty("accuracy");
    expect(model.estimatedAccuracies).toEqual(["conservative-heuristic"]);
    expect(sum(model.segments)).toBe(200_000);
    expect(model.counts).toEqual([{ key: "tools", label: "Tools", loaded: 9 }]);
  });

  it("says which accuracy each estimated part carries, whatever it is", () => {
    const model = providerWindowModel({
      breakdown: {
        parts: [
          { kind: "skills", tokens: 300, accuracy: "model-family-estimate" },
          { kind: "agents", tokens: 100, accuracy: "exact-tokenizer" },
        ],
      },
      usedTokens: 1_000,
      windowTokens: 10_000,
    });

    expect(model.segments.find((s) => s.key === "skills")).toMatchObject({
      estimated: true,
      accuracy: "model-family-estimate",
    });
    // An exact tokenizer count is a count, not an estimate.
    expect(model.segments.find((s) => s.key === "agents")?.estimated).toBeUndefined();
    expect(model.estimatedAccuracies).toEqual(["model-family-estimate"]);
  });

  it("stays a single Used segment for a runtime that reports one figure and nothing else", () => {
    const model = providerWindowModel({ usedTokens: 12_000, windowTokens: 200_000 });

    expect(model.segments.map((segment) => [segment.label, segment.tokens])).toEqual([
      ["Used", 12_000],
      ["Free space", 188_000],
    ]);
    expect(model.counts).toEqual([]);
  });

  it("holds what the parts add up to when they outrun the reported occupancy", () => {
    // The breakdown is taken after the reply and the occupancy before it, so the
    // parts can be the larger figure: the window holds them, and no remainder is
    // shown as negative.
    const model = providerWindowModel({
      breakdown: { parts: [{ kind: "messages", tokens: 5_000, accuracy: "provider-reported" }] },
      usedTokens: 4_800,
      windowTokens: 100_000,
    });

    expect(model.usedTokens).toBe(5_000);
    expect(model.segments.some((segment) => segment.key === "other-provider")).toBe(false);
    expect(sum(model.segments)).toBe(100_000);
  });

  it("holds reserved room to what the window has left, so the segments never add up to more than the window", () => {
    const model = providerWindowModel({
      breakdown: {
        parts: [
          { kind: "messages", tokens: 90_000, accuracy: "provider-reported" },
          { kind: "reserved", tokens: 50_000, accuracy: "provider-reported" },
        ],
      },
      usedTokens: 90_000,
      windowTokens: 100_000,
    });

    // 10,000 tokens are left after the 90,000 held; the reserve is 50,000, so
    // only the 10,000 that exist are shown, and nothing is left free.
    expect(model.segments.find((segment) => segment.kind === "reserved")).toMatchObject({
      tokens: 10_000,
      percent: 10,
    });
    expect(model.segments.find((segment) => segment.kind === "free")).toMatchObject({
      tokens: 0,
      percent: 0,
    });
    expect(sum(model.segments)).toBe(100_000);
    expect(
      model.segments.reduce((total, segment) => total + (segment.percent ?? 0), 0),
    ).toBeCloseTo(100);
  });

  it("shows no reserved room, and no free space, once the window is full", () => {
    const model = providerWindowModel({
      breakdown: { parts: [{ kind: "reserved", tokens: 50_000, accuracy: "provider-reported" }] },
      usedTokens: 100_000,
      windowTokens: 100_000,
    });

    expect(model.segments.some((segment) => segment.kind === "reserved")).toBe(false);
    expect(model.segments.find((segment) => segment.kind === "free")?.tokens).toBe(0);
  });

  it("keeps the whole reserve while it fits", () => {
    const model = providerWindowModel({
      breakdown: { parts: [{ kind: "reserved", tokens: 33_000, accuracy: "provider-reported" }] },
      usedTokens: 50_000,
      windowTokens: 1_000_000,
    });

    expect(model.segments.find((segment) => segment.kind === "reserved")?.tokens).toBe(33_000);
    expect(model.segments.find((segment) => segment.kind === "free")?.tokens).toBe(917_000);
  });
});

describe("category colours", () => {
  it("gives every category of a planned thread its own tone", () => {
    const keys = [
      "provider-framing",
      "octant-policy",
      "user-instructions",
      "project-instructions",
      "project-memory",
      "conversation",
      "current-request",
      "workspace-context",
      "extension-instructions",
      "octant-tools",
      "mcp",
      "tool-results",
      "subagent-results",
      "observed-overhead",
    ];
    const tones = keys.map((key) => contextCategoryTone(key));

    expect(tones.every((tone) => tone !== undefined)).toBe(true);
    expect(new Set(tones).size).toBe(keys.length);
  });

  it("gives every part of a provider-run window its own tone", () => {
    const keys = [
      "system-prompt",
      "system-tools",
      "mcp-tools",
      "memory-files",
      "skills",
      "agents",
      "messages",
      "other-provider",
    ];
    const tones = keys.map((key) => contextCategoryTone(key));

    expect(tones.every((tone) => tone !== undefined)).toBe(true);
    expect(new Set(tones).size).toBe(keys.length);
  });

  it("keeps one tone for a category wherever it is shown", () => {
    // A planned thread's MCP and a provider's MCP tools are one category.
    expect(contextCategoryTone("mcp")).toBe(contextCategoryTone("mcp-tools"));
    expect(contextCategoryTone("octant-tools")).toBe(contextCategoryTone("system-tools"));
    expect(contextCategoryTone("conversation")).toBe(contextCategoryTone("messages"));
    const harness = contextWindowModel(contextFixture());
    const provider = providerWindowModel({
      breakdown: {
        parts: [{ kind: "octant-tools", tokens: 10, accuracy: "conservative-heuristic" }],
      },
      usedTokens: 100,
      windowTokens: 1_000,
    });
    expect(harness.segments.find((s) => s.key === "octant-tools")?.tone).toBe(
      provider.segments.find((s) => s.key === "octant-tools")?.tone,
    );
  });

  it("lists parts in one fixed order, whatever order the runtime reported them in", () => {
    const model = providerWindowModel({
      breakdown: {
        parts: [
          { kind: "messages", tokens: 10, accuracy: "provider-reported" },
          { kind: "skills", tokens: 10, accuracy: "provider-reported" },
          { kind: "memory-files", tokens: 10, accuracy: "provider-reported" },
          { kind: "agents", tokens: 10, accuracy: "provider-reported" },
          { kind: "system-prompt", tokens: 10, accuracy: "provider-reported" },
        ],
      },
      usedTokens: 50,
      windowTokens: 1_000,
    });

    expect(model.segments.filter((s) => s.kind === "content").map((s) => s.key)).toEqual([
      "system-prompt",
      "agents",
      "memory-files",
      "skills",
      "messages",
    ]);
  });

  it("leaves free space and reserved room without a tone so they stay neutral", () => {
    const harness = contextWindowModel(contextFixture()).segments;
    const provider = providerWindowModel({
      breakdown: { parts: [{ kind: "reserved", tokens: 10, accuracy: "provider-reported" }] },
      usedTokens: 100,
      windowTokens: 1_000,
    }).segments;

    for (const segment of [...harness, ...provider]) {
      if (segment.kind === "free" || segment.kind === "reserved") {
        expect(segment).not.toHaveProperty("tone");
      } else {
        expect(segment.tone).toBeDefined();
      }
    }
  });
});
