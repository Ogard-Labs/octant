import { describe, expect, it, vi } from "vitest";
import { decodeComputerControlResult } from "@octant/contracts/computer-use-plugin";
import { createComputerUsePlugin } from "./computerUsePlugin";

describe("the bundled Computer use plugin", () => {
  it("passes the agent's reason to the host beside the command, not in it", async () => {
    const execute = vi.fn(async () => decodeComputerControlResult({ kind: "apps", apps: [] }));
    const plugin = createComputerUsePlugin({ execute });
    await plugin.execute({
      name: "octant_computer",
      inputJson: JSON.stringify({ operation: "apps", reason: "  Find the Notes app  " }),
    });
    expect(execute).toHaveBeenCalledWith({ operation: "apps" }, undefined, {
      reason: "Find the Notes app",
    });
  });

  it("offers the reason in the tool's input schema so a model may send it", () => {
    const plugin = createComputerUsePlugin({ execute: vi.fn() });
    expect(JSON.stringify(plugin.definitions[0]?.inputSchema)).toContain('"reason"');
  });
});
