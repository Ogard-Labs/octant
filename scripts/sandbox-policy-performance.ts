/** Reconciled Strict-policy calibration; excludes cold/provider startup and downloads. */
import { EventActor, Project } from "@octant/contracts";
import {
  decodeSandboxPolicy,
  decodeSandboxRestrictionsCommand,
} from "@octant/contracts/sandbox-policy";
import { Schema } from "effect";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeProcessConfinementLive } from "../apps/server/src/process/seatbeltProfile";
import { configureSandboxRestrictionsAuthority } from "../apps/server/src/process/sandboxRuntimePolicy";
import { SandboxRestrictionsService } from "../apps/server/src/sandboxRestrictionsService";

const rootDirectory = mkdtempSync(join(tmpdir(), "octant-policy-performance-"));
const projectRoot = join(rootDirectory, "project");
const scratch = join(rootDirectory, "scratch");
const privateData = join(rootDirectory, "private");
for (const path of [projectRoot, scratch, privateData]) mkdirSync(path);

const timestamp = "2026-11-17T00:00:00.000Z";
const actor = Schema.decodeUnknownSync(EventActor)({
  kind: "local-user",
  actorId: "99999999-9999-4999-8999-999999999999",
});
const project = Schema.decodeUnknownSync(Project)({
  id: "20000000-0000-4000-8000-000000000001",
  type: "work",
  name: "Performance calibration",
  lifecycle: "active",
  pinned: false,
  rank: "0/1",
  version: 1,
  createdAt: timestamp,
  updatedAt: timestamp,
  binding: { canonicalRoot: projectRoot },
  bindingHistory: [
    {
      revisionId: "30000000-0000-4000-8000-000000000001",
      revision: 1,
      currentBinding: { canonicalRoot: projectRoot },
      actor,
      changedAt: timestamp,
    },
  ],
});
const threadId = "10000000-0000-4000-8000-000000000001";
const service = new SandboxRestrictionsService({
  journal: { append: () => [], replayAggregateType: () => [] },
  hostId: "performance-host",
  actor,
  project: () => project,
  thread: () => ({ projectId: String(project.id), mode: "work" }),
  dataDirectory: privateData,
  strictPreferences: () => ({
    executionPolicy: "full-access",
    thread: { strict: true },
  }),
});
const policy = decodeSandboxPolicy({
  schemaVersion: 1,
  revision: 0,
  filesystem: { readOnlyRoots: [], readWriteRoots: [], protectedPaths: [] },
  network: "deny",
  credentials: "existing-policy",
  hostServices: "blocked",
});
service.change(
  decodeSandboxRestrictionsCommand({
    kind: "set-policy",
    scope: { kind: "settings", mode: "work" },
    policy,
    expectedVersion: 0,
  }),
);
configureSandboxRestrictionsAuthority(service);

const confinement = makeProcessConfinementLive();
const launch = {
  executable: "/usr/bin/python3",
  args: ["-c", "import hashlib\nfor i in range(60000): hashlib.sha256(str(i).encode()).digest()"],
  boundRoot: projectRoot,
  temporaryDirectory: scratch,
  networkEgress: "none" as const,
};
const median = (values: ReadonlyArray<number>) =>
  [...values].sort((left, right) => left - right)[Math.floor(values.length / 2)] as number;
const p95 = (values: ReadonlyArray<number>) =>
  [...values].sort((left, right) => left - right)[Math.ceil(values.length * 0.95) - 1] as number;
const admissionSamples: number[] = [];
const baselineSamples: number[] = [];
const selectedSamples: number[] = [];

try {
  for (let index = 0; index < 60; index++) {
    const preparationStarted = performance.now();
    const admission = service.beginTurn({
      threadId,
      projectId: String(project.id),
      mode: "work",
      root: projectRoot,
      provider: "codex",
    });
    if (admission.status !== "admitted" || admission.turn.selection === undefined)
      throw new Error("Strict policy was not admitted for calibration.");
    const selected = confinement.prepare({ ...launch, sandboxPolicy: admission.turn.selection });
    if (index >= 10) admissionSamples.push(performance.now() - preparationStarted);
    if (index < 30) {
      const baseline = confinement.prepare(launch);
      const measurements =
        index % 2 === 0
          ? ([
              [baseline, baselineSamples],
              [selected, selectedSamples],
            ] as const)
          : ([
              [selected, selectedSamples],
              [baseline, baselineSamples],
            ] as const);
      for (const [prepared, samples] of measurements) {
        const started = performance.now();
        const result = spawnSync(prepared.command, [...prepared.args], {
          cwd: projectRoot,
          env: { PATH: "/usr/bin:/bin", HOME: scratch },
          timeout: 10_000,
        });
        if (result.status !== 0)
          throw new Error(`Warm calibration workload failed (${result.status ?? "signal"}).`);
        if (index >= 5) samples.push(performance.now() - started);
      }
    }
    await admission.turn.end();
  }
  const baselineMedianMs = median(baselineSamples);
  const selectedMedianMs = median(selectedSamples);
  const medianChangePercent = (selectedMedianMs / baselineMedianMs - 1) * 100;
  const warmAdmissionAndPreparationP95Ms = p95(admissionSamples);
  const receipt = {
    status: "measured-reconciled-strict-performance",
    warmAdmissionAndPreparationSamples: admissionSamples.length,
    warmAdmissionAndPreparationP95Ms,
    pairedWarmWorkloadSamples: baselineSamples.length,
    baselineMedianMs,
    selectedMedianMs,
    medianChangePercent,
    budgets: { maximumWarmMedianRegressionPercent: 10, maximumWarmPreparationP95Ms: 250 },
    coldStartAndProviderStartupExcluded: true,
  };
  console.log(JSON.stringify(receipt));
  if (warmAdmissionAndPreparationP95Ms >= 250 || medianChangePercent >= 10)
    throw new Error("The reconciled Strict performance budget was exceeded.");
} finally {
  configureSandboxRestrictionsAuthority(undefined);
  rmSync(rootDirectory, { recursive: true, force: true });
}
