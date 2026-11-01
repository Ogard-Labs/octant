import { describe, expect, it, vi } from "vitest";
import { recordFirstRunMode } from "./recordFirstRunMode";

describe("recording the first-run mode", () => {
  it("sets the answer as the default for new Code threads and new Work threads", async () => {
    const saveCode = vi.fn(async () => true);
    const saveWork = vi.fn(async () => true);
    await expect(recordFirstRunMode("accept-edits", { saveCode, saveWork })).resolves.toBe(true);
    expect(saveCode).toHaveBeenCalledWith({
      executionPolicy: "auto-accept-edits",
      autoApprove: false,
    });
    expect(saveWork).toHaveBeenCalledWith("auto-accept-edits");
  });

  it("leaves Work asking first when the answer is Plan, which Work does not have", async () => {
    const saveWork = vi.fn(async () => true);
    await recordFirstRunMode("plan", { saveCode: async () => true, saveWork });
    expect(saveWork).toHaveBeenCalledWith("ask-first");
  });

  it("sets Full access for Work too", async () => {
    const saveWork = vi.fn(async () => true);
    await recordFirstRunMode("full-access", { saveCode: async () => true, saveWork });
    expect(saveWork).toHaveBeenCalledWith("full-access");
  });

  it("answers for Code alone when Work has no settings to write, and reports a failed Work save", async () => {
    await expect(recordFirstRunMode("auto", { saveCode: async () => true })).resolves.toBe(true);
    await expect(
      recordFirstRunMode("auto", { saveCode: async () => true, saveWork: async () => false }),
    ).resolves.toBe(false);
  });
});
