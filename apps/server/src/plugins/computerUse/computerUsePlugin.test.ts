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

  it("routes type-secret through ComputerUseHostPort.typeSecret and refuses it when unsupported", async () => {
    const execute = vi.fn(async () => decodeComputerControlResult({ kind: "apps", apps: [] }));
    const typeSecret = vi.fn(async () => decodeComputerControlResult({ kind: "typed" }));
    const plugin = createComputerUsePlugin({ execute, typeSecret });
    const handle = "11111111-1111-4111-8111-111111111111";
    const observationId = "22222222-2222-4222-8222-222222222222";
    const result = await plugin.execute({
      name: "octant_computer",
      inputJson: JSON.stringify({
        operation: "type-secret",
        handle,
        observationId,
        elementIndex: 4,
        reason: "Unlock the prompt",
      }),
    });
    expect(result).toEqual({ kind: "typed" });
    expect(execute).not.toHaveBeenCalled();
    expect(typeSecret).toHaveBeenCalledWith(
      { operation: "type-secret", handle, observationId, elementIndex: 4 },
      undefined,
      { reason: "Unlock the prompt" },
    );

    const desktopPlugin = createComputerUsePlugin({
      execute,
      disposableDesktop: {
        sendFile: vi.fn(),
        extend: vi.fn(),
      },
    });
    expect(JSON.stringify(desktopPlugin.definitions[0]?.inputSchema)).not.toContain("type-secret");
    expect(
      await desktopPlugin.execute({
        name: "octant_computer",
        inputJson: JSON.stringify({
          operation: "type-secret",
          handle,
          observationId,
          elementIndex: 4,
        }),
      }),
    ).toMatchObject({ kind: "refused", reason: "unsupported" });

    const macWithoutSecret = createComputerUsePlugin({ execute });
    expect(JSON.stringify(macWithoutSecret.definitions[0]?.inputSchema)).not.toContain(
      "type-secret",
    );
    expect(JSON.stringify(macWithoutSecret.definitions[0]?.inputSchema)).not.toContain('"handle"');
    expect(
      await macWithoutSecret.execute({
        name: "octant_computer",
        inputJson: JSON.stringify({
          operation: "type-secret",
          handle,
          observationId,
          elementIndex: 4,
        }),
      }),
    ).toMatchObject({ kind: "refused", reason: "unsupported" });
  });
});
