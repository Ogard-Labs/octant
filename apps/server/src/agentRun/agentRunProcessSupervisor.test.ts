import { describe, expect, it, vi } from "vitest";
import { decodeAgentRunId } from "@octant/contracts/agent-run";
import { AgentRunProcessSupervisor, type AgentRunProcessPort } from "./agentRunProcessSupervisor";

const runId = decodeAgentRunId("11111111-1111-4111-8111-111111111111");
const run = { id: runId } as never;

describe("AgentRunProcessSupervisor", () => {
  it("owns a real process handle, stops it, and removes it after exit", async () => {
    let onExit: (() => void) | undefined;
    const terminate = vi.fn(async () => {
      onExit?.();
    });
    const port: AgentRunProcessPort = {
      spawn: () => ({
        pid: 42,
        onExit: (listener) => {
          onExit = listener;
        },
        terminate,
      }),
    };
    const supervisor = new AgentRunProcessSupervisor({ port });

    supervisor.start(run);
    expect(supervisor.activeRunIds()).toEqual([runId]);
    await supervisor.stop(runId);

    expect(terminate).toHaveBeenCalledOnce();
    expect(supervisor.activeRunIds()).toEqual([]);
  });

  it("reports unexpected child exit exactly once", () => {
    let onExit: (() => void) | undefined;
    const onProcessDeath = vi.fn();
    const port: AgentRunProcessPort = {
      spawn: () => ({
        pid: 43,
        onExit: (listener) => {
          onExit = listener;
        },
        terminate: async () => undefined,
      }),
    };
    const supervisor = new AgentRunProcessSupervisor({ port, onProcessDeath });

    supervisor.start(run);
    onExit?.();
    onExit?.();

    expect(onProcessDeath).toHaveBeenCalledOnce();
    expect(onProcessDeath).toHaveBeenCalledWith(runId);
    expect(supervisor.activeRunIds()).toEqual([]);
  });

  it("observes receipt startup failures and terminates the owned child", async () => {
    const terminate = vi.fn(async () => undefined);
    const onProcessDeath = vi.fn();
    const receiptReady = Promise.reject(new Error("receipt unavailable"));
    const supervisor = new AgentRunProcessSupervisor({
      port: {
        spawn: () => ({
          pid: 44,
          receiptReady,
          onExit: () => undefined,
          terminate,
        }),
      },
      onProcessDeath,
    });

    supervisor.start(run);
    await vi.waitFor(() => expect(terminate).toHaveBeenCalledOnce());

    expect(onProcessDeath).toHaveBeenCalledOnce();
    expect(onProcessDeath).toHaveBeenCalledWith(runId);
    expect(supervisor.activeRunIds()).toEqual([]);
  });
});
