import { describe, expect, it, vi } from "vitest";
import { loadRuntimeServe, runtimeServeKind } from "./serveRuntime";

describe("server runtime selection", () => {
  it("selects Bun only when the current process reports a Bun runtime", () => {
    expect(runtimeServeKind({ bun: "1.3.14" })).toBe("bun");
    expect(runtimeServeKind({ node: "24.0.0", electron: "43.1.0" })).toBe("node");
  });

  it("loads only the selected runtime adapter", async () => {
    const bunServe = vi.fn();
    const nodeServe = vi.fn();
    const loadBun = vi.fn(async () => bunServe);
    const loadNode = vi.fn(async () => nodeServe);

    await expect(
      loadRuntimeServe({ versions: { electron: "43.1.0" }, loadBun, loadNode }),
    ).resolves.toBe(nodeServe);
    expect(loadBun).not.toHaveBeenCalled();
    expect(loadNode).toHaveBeenCalledOnce();
  });
});
