import { describe, expect, it } from "vitest";
import {
  suggestModelRoles,
  type RoleSuggestion,
  type RoleSuggestionModel,
} from "./modelRoleSuggestionPolicy";

function model(
  provider: string,
  kind: string,
  id: string,
  overrides: Partial<RoleSuggestionModel> = {},
): RoleSuggestionModel {
  return {
    providerInstanceId: provider,
    providerKind: kind,
    providerLabel: provider,
    modelId: id,
    displayName: id,
    readsImages: true,
    toolsReady: true,
    ready: true,
    atUsageLimit: false,
    ...overrides,
  };
}

const claude = [
  model("claude", "claude", "Fable 5.2"),
  model("claude", "claude", "Opus 5.5"),
  model("claude", "claude", "Sonnet 5.5"),
  model("claude", "claude", "Haiku 5.5"),
];
const other = [
  model("gpt", "openai", "Zeta 9", { readsImages: false }),
  model("gpt", "openai", "Zeta Mini 9", { readsImages: false }),
];

function roleOf(suggestions: ReadonlyArray<RoleSuggestion>, id: string): RoleSuggestion {
  const found = suggestions.find((entry) => entry.roleId === id);
  if (found === undefined) throw new Error(`no suggestion for ${id}`);
  return found;
}
const mainOf = (suggestions: ReadonlyArray<RoleSuggestion>, id: string) =>
  roleOf(suggestions, id).picks[0]?.modelId;

describe("suggesting model roles", () => {
  it("puts Fable on the Planner, Opus on hard problems, Sonnet on the Builder and Haiku on small work", () => {
    const result = suggestModelRoles({ models: claude });
    expect(mainOf(result, "plan")).toBe("Fable 5.2");
    expect(mainOf(result, "deep")).toBe("Opus 5.5");
    expect(mainOf(result, "default")).toBe("Sonnet 5.5");
    expect(mainOf(result, "quick")).toBe("Haiku 5.5");
    expect(mainOf(result, "task")).toBe("Haiku 5.5");
    expect(mainOf(result, "smol")).toBe("Haiku 5.5");
  });

  it("plans with Opus when no Fable is connected", () => {
    const result = suggestModelRoles({ models: claude.filter((m) => m.modelId !== "Fable 5.2") });
    expect(mainOf(result, "plan")).toBe("Opus 5.5");
  });

  it("gives Sees images only a model that reads images", () => {
    const result = suggestModelRoles({
      models: [
        model("claude", "claude", "Haiku 5.5", { readsImages: false }),
        ...claude.slice(2, 3),
      ],
    });
    expect(mainOf(result, "vision")).toBe("Sonnet 5.5");
    const none = suggestModelRoles({ models: other });
    expect(roleOf(none, "vision").picks).toEqual([]);
    expect(roleOf(none, "vision").note).toMatch(/reads images/);
  });

  it("never suggests a model without proven tools for a role that runs tools", () => {
    const result = suggestModelRoles({
      models: [
        model("gpt", "openai", "Zeta Mini 9", { toolsReady: false }),
        model("claude", "claude", "Haiku 5.5"),
      ],
    });
    expect(roleOf(result, "quick").picks.map((pick) => pick.modelId)).not.toContain("Zeta Mini 9");
    // Small jobs run no tools, so the chat-only model may serve them.
    expect(
      roleOf(
        suggestModelRoles({
          models: [model("gpt", "openai", "Zeta Mini 9", { toolsReady: false })],
        }),
        "smol",
      ).picks[0]?.modelId,
    ).toBe("Zeta Mini 9");
  });

  it("asks a different provider to review than the one that builds", () => {
    const result = suggestModelRoles({ models: [...claude, ...other] });
    expect(mainOf(result, "default")).toBe("Sonnet 5.5");
    const reviewer = roleOf(result, "slow");
    expect(reviewer.picks[0]?.modelId).toMatch(/Zeta/);
    expect(reviewer.picks[0]?.reason).toMatch(/different provider than the Builder/);
  });

  it("reviews on the same provider when it is the only one connected", () => {
    expect(mainOf(suggestModelRoles({ models: claude }), "slow")).toBe("Sonnet 5.5");
  });

  it("takes a fallback from another provider, then another account, then a sibling", () => {
    const mixed = suggestModelRoles({ models: [...claude, ...other] });
    expect(roleOf(mixed, "default").picks[1]).toMatchObject({ kind: "fallback" });
    expect(roleOf(mixed, "default").picks[1]?.providerInstanceId).toBe("gpt");

    const accounts = suggestModelRoles({
      models: [model("a", "claude", "Sonnet 5.5"), model("b", "claude", "Sonnet 5.5")],
    });
    expect(roleOf(accounts, "default").picks[1]?.providerInstanceId).toBe("b");
    expect(roleOf(accounts, "default").picks[1]?.reason).toMatch(/different account/);

    const sibling = suggestModelRoles({ models: claude });
    expect(roleOf(sibling, "default").picks[1]?.providerInstanceId).toBe("claude");
    expect(roleOf(sibling, "default").picks[1]?.reason).toMatch(/sibling/);
  });

  it("says no fallback when only one model fits", () => {
    const result = suggestModelRoles({ models: [model("claude", "claude", "Sonnet 5.5")] });
    expect(roleOf(result, "default").picks).toHaveLength(1);
    expect(roleOf(result, "default").note).toMatch(/No fallback/);
  });

  it("places models of an unknown tier after known ones and says so", () => {
    const result = suggestModelRoles({
      models: [model("gpt", "openai", "Zeta 9"), model("claude", "claude", "Sonnet 5.5")],
    });
    const builder = roleOf(result, "default");
    expect(builder.picks[0]?.modelId).toBe("Sonnet 5.5");
    expect(builder.picks[1]?.modelId).toBe("Zeta 9");
    const alone = suggestModelRoles({ models: [model("gpt", "openai", "Zeta 9")] });
    expect(roleOf(alone, "default").picks[0]?.reason).toMatch(/tier unknown/);
  });

  it("reads a tier from a name only when the family is not known", () => {
    const result = suggestModelRoles({
      models: [model("gpt", "openai", "Zeta Mini 9"), model("gpt", "openai", "Zeta Pro 9")],
    });
    expect(mainOf(result, "quick")).toBe("Zeta Mini 9");
    expect(mainOf(result, "plan")).toBe("Zeta Pro 9");
    expect(roleOf(result, "quick").picks[0]?.reason).toMatch(/read from its name/);
  });

  it("skips signed-out and at-limit models and uses the next best", () => {
    const result = suggestModelRoles({
      models: [
        model("claude", "claude", "Sonnet 5.5", { atUsageLimit: true }),
        model("claude2", "claude", "Sonnet 5.5", { ready: false }),
        model("claude", "claude", "Opus 5.5"),
      ],
    });
    expect(mainOf(result, "default")).toBe("Opus 5.5");
  });

  it("leaves a role empty with a reason when nothing connected fits", () => {
    const result = suggestModelRoles({ models: [] });
    expect(roleOf(result, "plan")).toMatchObject({ picks: [] });
    expect(roleOf(result, "plan").note).toBeDefined();
  });

  it("suggests only the roles asked for, and reviews against the saved Builder", () => {
    const result = suggestModelRoles({
      models: [...claude, ...other],
      roleIds: ["slow"],
      builderMain: { providerKind: "openai" },
    });
    expect(result.map((entry) => entry.roleId)).toEqual(["slow"]);
    expect(result[0]?.picks[0]?.modelId).toBe("Sonnet 5.5");
  });

  it("hints a reasoning level only when the model offers it", () => {
    const result = suggestModelRoles({
      models: [model("claude", "claude", "Opus 5.5", { reasoningLevels: ["low", "high"] })],
    });
    expect(roleOf(result, "plan").picks[0]?.reasoning).toBe("high");
    expect(roleOf(result, "default").picks[0]?.reasoning).toBeUndefined();
  });
});
