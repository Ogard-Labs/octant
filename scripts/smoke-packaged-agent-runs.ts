import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { decodeAgentRunId, type AgentRun } from "@octant/contracts/agent-run";
import { AgentRunProcessSupervisor } from "../apps/server/src/agentRun/agentRunProcessSupervisor";
import { createNodeAgentRunProcessPort } from "../apps/server/src/agentRun/nodeAgentRunProcessPort";
import { runBoundedCommand, sanitizedPackagedEnvironment } from "./packaged-smoke-process";

export const PACKAGED_AGENT_RUN_SMOKE_STEPS = [
  "package",
  "orchestration-and-isolation",
  "packaged-child-supervision",
  "restart-replay",
  "cleanup",
] as const;
export type PackagedAgentRunSmokeStep = (typeof PACKAGED_AGENT_RUN_SMOKE_STEPS)[number];

export async function runPackagedAgentRunSmoke(
  run: (step: PackagedAgentRunSmokeStep) => Promise<void>,
): Promise<void> {
  for (const step of PACKAGED_AGENT_RUN_SMOKE_STEPS) {
    try {
      await run(step);
    } catch {
      throw new Error(`Packaged AgentRun smoke failed during ${step}.`);
    }
  }
}

const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const packagedExecutable = resolve(repositoryRoot, "out/Octant.app/Contents/MacOS/Octant");

async function main(): Promise<void> {
  if (process.env.OCTANT_PACKAGED_AGENT_RUN_SMOKE !== "1") {
    throw new Error("Set OCTANT_PACKAGED_AGENT_RUN_SMOKE=1 to run the packaged AgentRun smoke.");
  }
  if (process.platform !== "darwin" || process.arch !== "arm64") {
    throw new Error("The packaged AgentRun smoke requires Apple Silicon macOS.");
  }
  await runPackagedAgentRunSmoke(async (step) => {
    switch (step) {
      case "package":
        await command(process.execPath, ["run", "build"]);
        await command(process.execPath, ["run", "package:desktop"]);
        return;
      case "orchestration-and-isolation":
        await command(process.execPath, [
          "x",
          "vitest",
          "run",
          "apps/server/src/agentRun/agentRunOrchestrationService.test.ts",
        ]);
        return;
      case "packaged-child-supervision":
        await runPackagedChildSupervision();
        return;
      case "restart-replay":
        await command(process.execPath, [
          "x",
          "vitest",
          "run",
          "apps/server/src/agentRun/agentRunEventStore.test.ts",
          "apps/server/src/agentRun/agentRunPersistenceService.test.ts",
        ]);
        return;
      case "cleanup":
        await command(process.execPath, ["scripts/smoke-packaged-desktop.ts"]);
    }
  });
  console.log("Packaged AgentRun isolated child supervision, replay, and cleanup smoke passed.");
}

export async function runPackagedChildSupervision(): Promise<void> {
  const environment = sanitizedPackagedEnvironment(
    process.env,
    `${process.env.TMPDIR ?? "/tmp"}/octant-packaged-agent-run-smoke`,
  );
  const port = createNodeAgentRunProcessPort({
    command: () => ({
      command: packagedExecutable,
      args: [
        "-e",
        "const timer=setInterval(()=>{},1000); process.once('SIGTERM',()=>{clearInterval(timer); process.exit(0)});",
      ],
      env: { ...environment, ELECTRON_RUN_AS_NODE: "1" },
    }),
    shutdownTimeoutMs: 2_000,
  });
  const supervisor = new AgentRunProcessSupervisor({ port });
  const parent = { id: decodeAgentRunId("11111111-1111-4111-8111-111111111111") } as AgentRun;
  const child = { id: decodeAgentRunId("22222222-2222-4222-8222-222222222222") } as AgentRun;
  supervisor.start(parent);
  supervisor.start(child);
  try {
    await wait(100);
    for (const runId of [parent.id, child.id]) assertAlive(supervisor, runId);
    // Leaf-first cancellation is explicit: child before parent.
    await supervisor.stop(child.id);
    await supervisor.stop(parent.id);
    if (supervisor.activeRunIds().length !== 0) {
      throw new Error("Packaged AgentRun supervisor retained a child after cleanup.");
    }
  } finally {
    await Promise.allSettled(supervisor.activeRunIds().map((runId) => supervisor.stop(runId)));
  }
}

function assertAlive(supervisor: AgentRunProcessSupervisor, runId: AgentRun["id"]): void {
  const ids = supervisor.activeRunIds();
  if (!ids.some((candidate) => String(candidate) === String(runId))) {
    throw new Error("Packaged AgentRun child exited before cancellation evidence.");
  }
}

async function command(executable: string, arguments_: readonly string[]): Promise<void> {
  await runBoundedCommand(
    executable,
    arguments_,
    sanitizedPackagedEnvironment(process.env, `${process.env.TMPDIR ?? "/tmp"}/octant-agent-run`),
    180_000,
  );
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

if (import.meta.main) await main();
