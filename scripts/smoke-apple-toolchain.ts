import { randomUUID } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LOCAL_TOOL_HOST_ID,
  type AppleBuildRequest,
  type AppleSimulatorRequest,
  type ToolActionAuthority,
} from "../packages/contracts/src/index";
import { AppleRuntimeStore } from "../apps/server/src/apple/appleRuntimeStore";
import {
  AppleToolchainService,
  type AppleExecutionContext,
} from "../apps/server/src/apple/appleToolchainService";
import { RepositoryTestProcessPort } from "../apps/server/src/code/repositoryTestProcessPort";

const repositoryRoot = await realpath(process.cwd());
const stateRoot = await mkdtemp(join(tmpdir(), "octant-apple-smoke-"));
const store = new AppleRuntimeStore(stateRoot);
const processPort = new RepositoryTestProcessPort();
const authority: ToolActionAuthority = {
  hostId: LOCAL_TOOL_HOST_ID,
  mode: "code",
  projectId: "a1000000-0000-4000-8000-000000000001" as never,
  providerInstanceId: "a1000000-0000-4000-8000-000000000002" as never,
  extension: { kind: "core" },
};
const threadId = "a1000000-0000-4000-8000-000000000003" as never;
const checkoutId = "a1000000-0000-4000-8000-000000000004" as never;
const context: AppleExecutionContext = {
  authority,
  threadId,
  checkoutId,
  checkoutRoot: repositoryRoot,
  artifactRoot: store.artifactRoot,
  sourceRevision: sourceRevision(),
  executionPolicy: "full-access",
  approvalValid: true,
};
const projectPath = "apps/server/src/apple/fixtures/SimulatorFixture/SimulatorFixture.xcodeproj";
const service = new AppleToolchainService({
  execute: (input, signal) => processPort.execute(input, signal),
  realpath,
  writeArtifact: (reference, bytes) => store.writeArtifact(reference, bytes),
  persistReceipts: (receipts) => store.persistReceipts(receipts),
  now: () => new Date().toISOString(),
  newId: randomUUID,
});

let simulatorId: string | undefined;
let bootedBySmoke = false;
let launched = false;
const evidence: Array<{
  readonly action: string;
  readonly outcome: string;
  readonly cleanup: string;
}> = [];

try {
  const discovery = await service.discover(
    {
      actionId: randomUUID() as never,
      correlationId: randomUUID() as never,
      authority,
      threadId,
      checkoutId,
      projectPath,
    },
    context,
  );
  if (discovery.kind !== "discovered") throw new Error(discovery.failure.message);
  const simulator = discovery.simulators.find(
    (candidate) => candidate.platform === "ios" && candidate.state !== "unavailable",
  );
  if (simulator === undefined) throw new Error("No available iOS Simulator was discovered.");
  simulatorId = simulator.simulatorId;
  if (simulator.state !== "booted") {
    const boot = await service.execute(simulatorAction("boot", simulatorId), context);
    requireSuccess(boot);
    evidence.push(summary(boot));
    bootedBySmoke = true;
  }

  for (const kind of ["build", "test", "run"] as const) {
    const result = await service.execute(buildAction(kind, simulatorId), context);
    requireSuccess(result);
    evidence.push(summary(result));
    if (kind === "run") launched = true;
  }

  const logs = await service.execute(
    simulatorAction("logs", simulatorId, "app.octant.simulatorfixture"),
    context,
  );
  requireSuccess(logs);
  evidence.push(summary(logs));

  const terminate = await service.execute(
    simulatorAction("terminate", simulatorId, "app.octant.simulatorfixture"),
    context,
  );
  requireSuccess(terminate);
  evidence.push(summary(terminate));
  launched = false;

  if (bootedBySmoke) {
    const shutdown = await service.execute(simulatorAction("shutdown", simulatorId), context);
    requireSuccess(shutdown);
    evidence.push(summary(shutdown));
    bootedBySmoke = false;
  }

  console.info(
    `APPLE_SMOKE_EVIDENCE=${JSON.stringify({
      xcodeVersion: discovery.toolchain.xcodeVersion,
      sdkCount: discovery.toolchain.sdks.length,
      simulator: {
        name: simulator.name,
        runtimeVersion: simulator.runtimeVersion,
      },
      project: {
        kind: discovery.workspace.projectKind,
        schemes: discovery.workspace.schemes,
        targets: discovery.workspace.targets,
      },
      actions: evidence,
      extensionRequired: false,
    })}`,
  );
} finally {
  if (simulatorId !== undefined && launched) {
    await service
      .execute(simulatorAction("terminate", simulatorId, "app.octant.simulatorfixture"), context)
      .catch(() => undefined);
  }
  if (simulatorId !== undefined && bootedBySmoke) {
    await service.execute(simulatorAction("shutdown", simulatorId), context).catch(() => undefined);
  }
  await service.close();
  await rm(stateRoot, { recursive: true, force: true });
}

function buildAction(
  kind: "build" | "test" | "run",
  selectedSimulatorId: string,
): AppleBuildRequest {
  return {
    actionId: randomUUID() as never,
    correlationId: randomUUID() as never,
    authority,
    threadId,
    checkoutId,
    kind,
    platform: "ios",
    scheme: "SimulatorFixture",
    configuration: "debug",
    simulatorId: selectedSimulatorId as never,
    projectPath,
    timeoutMs: 10 * 60_000,
    approval: { kind: "not-required" },
  };
}

function simulatorAction(
  kind: "boot" | "shutdown" | "terminate" | "logs",
  selectedSimulatorId: string,
  bundleIdentifier?: string,
): AppleSimulatorRequest {
  return {
    actionId: randomUUID() as never,
    correlationId: randomUUID() as never,
    authority,
    threadId,
    checkoutId,
    kind,
    simulatorId: selectedSimulatorId as never,
    ...(bundleIdentifier === undefined ? {} : { bundleIdentifier }),
    timeoutMs: 2 * 60_000,
    approval: { kind: "not-required" },
  };
}

function requireSuccess(result: {
  readonly kind: string;
  readonly outcome: string;
  readonly diagnostics?: ReadonlyArray<{ readonly message: string }>;
}): void {
  if (result.outcome !== "succeeded") {
    console.error(
      `APPLE_SMOKE_FAILURE=${JSON.stringify({
        action: result.kind,
        outcome: result.outcome,
        diagnostics: result.diagnostics?.map(({ message }) => message) ?? [],
      })}`,
    );
    throw new Error(`Apple ${result.kind} smoke ended ${result.outcome}.`);
  }
}

function summary(result: {
  readonly kind: string;
  readonly outcome: string;
  readonly cleanup: string;
}) {
  return { action: result.kind, outcome: result.outcome, cleanup: result.cleanup };
}

function sourceRevision(): string {
  const result = Bun.spawnSync(["git", "rev-parse", "HEAD"], {
    cwd: repositoryRoot,
    stdout: "pipe",
    stderr: "ignore",
  });
  const revision = result.stdout.toString().trim();
  return /^[a-f0-9]{40,64}$/.test(revision) ? revision : "0".repeat(40);
}
