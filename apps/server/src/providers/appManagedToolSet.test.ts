import { describe, expect, it, vi } from "vitest";
import {
  combineAppManagedToolSets,
  withToolFamilyHelp,
  type AppManagedToolSet,
} from "./appManagedToolSet";

function toolSet(name: string): AppManagedToolSet & { execute: ReturnType<typeof vi.fn> } {
  return {
    definitions: [{ name, inputSchema: { type: "object" } } as never],
    execute: vi.fn(async () => ({ result: { from: name }, isError: false })),
  };
}

describe("combineAppManagedToolSets", () => {
  it("closes a turn's owned resources once even when cleanup is requested twice", async () => {
    const close = vi.fn(async () => {});
    const combined = combineAppManagedToolSets({ ...toolSet("octant_computer"), close });
    await Promise.all([combined.close?.(), combined.close?.()]);
    expect(close).toHaveBeenCalledOnce();
  });
  it("concatenates definitions and routes execution to the owning set", async () => {
    const first = toolSet("octant_terminal");
    const second = toolSet("octant_github");
    const combined = combineAppManagedToolSets(first, second);

    expect(combined.definitions.map((definition) => definition.name)).toEqual([
      "octant_terminal",
      "octant_github",
    ]);
    expect(await combined.execute({ name: "octant_github", inputJson: "{}" })).toEqual({
      result: { from: "octant_github" },
      isError: false,
    });
    expect(first.execute).not.toHaveBeenCalled();
    expect(second.execute).toHaveBeenCalledOnce();
  });

  it("fails closed for a tool no combined set owns", async () => {
    const combined = combineAppManagedToolSets(toolSet("octant_terminal"));
    const outcome = await combined.execute({ name: "octant_unknown", inputJson: "{}" });
    expect(outcome.isError).toBe(true);
  });

  it("skips undefined sets so optional capabilities compose cleanly", async () => {
    const only = toolSet("octant_github");
    const combined = combineAppManagedToolSets(undefined, only, undefined);
    expect(combined.definitions).toHaveLength(1);
  });
});

describe("withToolFamilyHelp", () => {
  it("answers help for an offered family from its usage text without reaching the executor", async () => {
    const family = toolSet("octant_terminal");
    const tools = withToolFamilyHelp(family, { octant_terminal: "Run starts a command." });

    expect(
      await tools.execute({ name: "octant_terminal", inputJson: '{"operation":"help"}' }),
    ).toEqual({
      result: { tool: "octant_terminal", help: "Run starts a command." },
      isError: false,
    });
    expect(family.execute).not.toHaveBeenCalled();
    expect(tools.definitions).toBe(family.definitions);
  });

  it("passes every other action to the family's own executor unchanged", async () => {
    const family = toolSet("octant_terminal");
    const tools = withToolFamilyHelp(family, { octant_terminal: "Run starts a command." });
    const call = { name: "octant_terminal", inputJson: '{"operation":"run","command":"ls"}' };

    expect(await tools.execute(call)).toEqual({
      result: { from: "octant_terminal" },
      isError: false,
    });
    expect(family.execute).toHaveBeenCalledWith(call);
  });

  it("gives no help for a family the set does not offer, so an omitted grant stays omitted", async () => {
    const family: AppManagedToolSet & { execute: ReturnType<typeof vi.fn> } = {
      definitions: [],
      execute: vi.fn(async () => ({ result: { error: "tool-unavailable" }, isError: true })),
    };
    const tools = withToolFamilyHelp(family, { octant_browser: "Navigate first." });

    const outcome = await tools.execute({
      name: "octant_browser",
      inputJson: '{"operation":"help"}',
    });
    expect(outcome).toEqual({ result: { error: "tool-unavailable" }, isError: true });
    expect(family.execute).toHaveBeenCalledOnce();
  });
});
