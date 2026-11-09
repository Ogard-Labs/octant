import { describe, expect, it, vi } from "vitest";
import { contributedCodeToolName, createContributedCodeTool } from "./codeTools";
import type { CodeToolHostPort } from "@octant/plugin-api/code-tools";

describe("declared Code capabilities", () => {
  it("limits metadata and execution to declared host operations and withholds a revoked result", async () => {
    let current = true;
    let finish: (() => void) | undefined;
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const request = vi.fn(async () => {
      await pending;
      return { result: { status: "used" } };
    });
    const port: CodeToolHostPort = {
      operations: () =>
        current
          ? [
              { id: "check", label: "Check", reason: "Read status" },
              { id: "other", label: "Other", reason: "Other status" },
            ]
          : undefined,
      savedCommands: () => (current ? [] : undefined),
      request,
      runSaved: vi.fn(),
      close: async () => {
        current = false;
      },
    };
    const name = contributedCodeToolName("10000000-0000-4000-8000-000000000001", "code-check");
    expect(name).not.toBe("octant_credential");
    const set = createContributedCodeTool({
      name,
      contribution: {
        id: "check",
        label: "Check",
        description: "Check status",
        operationIds: ["check"],
        savedCommandIds: [],
      },
      port,
    });
    expect(await set.execute({ name, inputJson: '{"operation":"list"}' })).toMatchObject({
      result: { operations: [{ id: "check" }], savedCommands: [] },
    });
    expect(
      await set.execute({ name, inputJson: '{"operation":"request","id":"other"}' }),
    ).toMatchObject({ isError: true });
    expect(request).not.toHaveBeenCalled();
    const result = set.execute({ name, inputJson: '{"operation":"request","id":"check"}' });
    current = false;
    finish?.();
    expect(await result).toMatchObject({ result: { status: "refused" }, isError: true });
    await set.close();
  });
});
