import { describe, expect, it, vi } from "vitest";
import { isToolAllowedByAllowlist } from "@octant/domain";
import {
  AgentRunChildResources,
  createAgentRunChildToolHosts,
  whileChildHolds,
  whileChildRuns,
  type AgentRunChildToolDependencies,
} from "./agentRunChildTools";
import { CHILD_WINDOW, childHost, childRun } from "./agentRunChildTools.test-support";

const deps = (
  overrides: Partial<AgentRunChildToolDependencies> = {},
): AgentRunChildToolDependencies => ({
  isCurrent: () => true,
  carriesTools: () => true,
  parent: () => ({ toolConstraints: [], inPlan: false, carriesTools: true }),
  window: () => CHILD_WINDOW as never,
  windowCanAnswer: () => true,
  approvals: () => ({ askTool: async () => "approved" }),
  toolAllowed: isToolAllowedByAllowlist,
  ...overrides,
});
const resolve = (
  overrides: Partial<AgentRunChildToolDependencies> = {},
  run = childRun(),
  tool = "octant_code",
) =>
  createAgentRunChildToolHosts(deps(overrides))(
    { run, authority: run.authority, projectRoot: "/child" },
    tool,
  );

describe("a child run's inherited tools", () => {
  it("offers nothing to a child whose grant holds no tools, whose launch carries none, or whose parent was offered none", () => {
    expect(resolve()).toBeDefined();
    expect(resolve({}, childRun({ tools: false }))).toBeUndefined();
    expect(resolve({ carriesTools: () => false })).toBeUndefined();
    expect(
      resolve({ parent: () => ({ toolConstraints: [], inPlan: false, carriesTools: false }) }),
    ).toBeUndefined();
    expect(resolve({ parent: () => undefined })).toBeUndefined();
  });

  it("offers no tool the parent thread's profile leaves out", () => {
    const parent = () => ({
      toolConstraints: ["octant_code"],
      inPlan: false,
      carriesTools: true,
    });
    expect(resolve({ parent })).toBeDefined();
    expect(resolve({ parent }, childRun(), "octant_github")).toBeUndefined();
  });

  it("works in the child's own folder under the child's own identity", () => {
    const host = resolve();
    expect(host).toMatchObject({
      runId: String(childRun().id),
      folder: "/child",
      target: { modelId: "worker-model" },
    });
    expect(host?.runId).not.toBe(host?.parentThreadId);
    expect(resolve({}, childRun({ mode: "chat" }))?.folder).toBeUndefined();
  });

  it("refuses a call once the run, the parent's grant, or the parent's tools no longer allow it", async () => {
    let held = true;
    let inPlan = false;
    const host = resolve({
      isCurrent: () => held,
      parent: () => ({ toolConstraints: [], inPlan, carriesTools: true }),
    });
    if (host === undefined) throw new Error("Expected a host.");
    const execute = vi.fn(async () => ({ result: "ran" }));
    const tools = whileChildHolds(host, { definitions: [], execute });
    const call = { name: "octant_code", inputJson: "{}" };
    expect(await tools?.execute(call)).toEqual({ result: "ran" });
    inPlan = true;
    expect(await tools?.execute(call)).toMatchObject({
      isError: true,
      result: { error: "child-authority-changed" },
    });
    inPlan = false;
    held = false;
    expect(await tools?.execute(call)).toMatchObject({ isError: true });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("has nobody to ask under a routine, in Plan, or once its window is gone", async () => {
    const askTool = vi.fn(async () => "approved" as const);
    const approvals = () => ({ askTool });
    const ask = { summary: "Run this?", approvalClass: "terminal" };
    const attended = resolve({ approvals });
    expect(attended?.attended()).toBe(true);
    expect(await attended?.ask(ask)).toBe("approved");
    for (const host of [
      resolve({ approvals, windowCanAnswer: () => false }),
      resolve({ approvals, window: () => undefined }),
      resolve({ approvals }, childRun({ policy: "plan" })),
    ]) {
      expect(host?.attended()).toBe(false);
      expect(await host?.ask(ask)).toBe("denied");
    }
    expect(askTool).toHaveBeenCalledTimes(1);
  });

  it("stops what a child started when its run ends or no longer holds its grant, once", async () => {
    const resources = new AgentRunChildResources();
    let held = true;
    const stopped = vi.fn(async () => undefined);
    const other = vi.fn(async () => undefined);
    resources.hold({ current: () => held }, stopped);
    resources.hold({ current: () => true }, other);
    await resources.settle();
    expect(stopped).not.toHaveBeenCalled();
    held = false;
    await resources.settle();
    await resources.settle();
    expect(stopped).toHaveBeenCalledTimes(1);
    expect(other).not.toHaveBeenCalled();
    await resources.close();
    expect(other).toHaveBeenCalledTimes(1);
  });

  it("starts nothing until a call, and ends what calls started when the run ends", async () => {
    const resources = new AgentRunChildResources();
    const end = vi.fn(async () => undefined);
    const acquire = vi.fn(() => end);
    const tools = whileChildRuns({
      host: childHost(),
      resources,
      tools: { definitions: [], execute: async () => ({ result: "started" }) },
      acquire,
    });
    // Preflight composes the set and drops it.
    expect(acquire).not.toHaveBeenCalled();
    await tools?.execute({ name: "octant_terminal", inputJson: "{}" });
    await tools?.execute({ name: "octant_terminal", inputJson: "{}" });
    expect(acquire).toHaveBeenCalledTimes(1);
    await tools?.close?.();
    expect(end).toHaveBeenCalledTimes(1);
    expect(await tools?.execute({ name: "octant_terminal", inputJson: "{}" })).toMatchObject({
      isError: true,
    });
    expect(acquire).toHaveBeenCalledTimes(1);
  });

  it("ends what a call started when the child lost its grant while the call ran", async () => {
    let held = true;
    const end = vi.fn(async () => undefined);
    const tools = whileChildRuns({
      host: childHost({ current: () => held }),
      resources: new AgentRunChildResources(),
      tools: {
        definitions: [],
        execute: async () => {
          held = false;
          return { result: "started" };
        },
      },
      acquire: () => end,
    });
    await tools?.execute({ name: "octant_terminal", inputJson: "{}" });
    expect(end).toHaveBeenCalledTimes(1);
  });
});
