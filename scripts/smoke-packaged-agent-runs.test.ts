import { describe, expect, it, vi } from "vitest";
import {
  PACKAGED_AGENT_RUN_SMOKE_STEPS,
  runPackagedAgentRunSmoke,
} from "./smoke-packaged-agent-runs";

describe("packaged AgentRun smoke orchestration", () => {
  it("runs exact-head provider, lifecycle, packaged-child, replay, and cleanup phases", async () => {
    const run = vi.fn(async () => undefined);
    await runPackagedAgentRunSmoke(run);
    expect(run.mock.calls.map(([step]) => step)).toEqual([...PACKAGED_AGENT_RUN_SMOKE_STEPS]);
  });

  it("stops at the first failed phase without exposing raw diagnostics", async () => {
    const run = vi.fn(async (step: string) => {
      if (step === "packaged-child-supervision") throw new Error("private process path");
    });
    await expect(runPackagedAgentRunSmoke(run)).rejects.toThrow(
      "Packaged AgentRun smoke failed during packaged-child-supervision.",
    );
    const failure = await runPackagedAgentRunSmoke(run).catch((error) => error);
    expect(JSON.stringify(failure)).not.toContain("private process path");
  });
});
