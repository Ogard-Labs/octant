import { describe, expect, it, vi } from "vitest";
import { combineAppManagedToolSets, type AppManagedToolSet } from "./appManagedToolSet";

function toolSet(name: string): AppManagedToolSet & { execute: ReturnType<typeof vi.fn> } {
  return {
    definitions: [{ name, inputSchema: { type: "object" } } as never],
    execute: vi.fn(async () => ({ result: { from: name }, isError: false })),
  };
}

describe("combineAppManagedToolSets", () => {
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
