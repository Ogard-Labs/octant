import type { SandboxPolicySelection } from "@octant/contracts/sandbox-policy";
import { Schema } from "effect";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { secretGuardMediationPolicy } from "./secretGuard";
import type { ConfinedProcessLaunch, ProcessConfinementPrepareInput } from "./seatbeltProfile";
import {
  LinuxMediationSupervisorConfig,
  type LinuxMediationSupervisorConfig as SupervisorConfig,
} from "./linuxMediationConfig";
import { LINUX_MEDIATION_PRODUCTION_MAXIMUM_MS } from "./linuxMediationBroker";

function installed(paths: ReadonlyArray<string>): Buffer | undefined {
  const path = paths.find(existsSync);
  return path === undefined ? undefined : readFileSync(path);
}

// Capture packaged code at server startup, before any selected workload can
// modify a development checkout or a later path lookup.
const nativeImage =
  process.platform === "linux"
    ? installed([
        fileURLToPath(new URL("../../dist/native/octant-mediation", import.meta.url)),
        fileURLToPath(new URL("./native/octant-mediation", import.meta.url)),
      ])
    : undefined;
const workerImage =
  process.platform === "linux"
    ? installed([
        fileURLToPath(new URL("../../dist/linuxMediationWorker.mjs", import.meta.url)),
        fileURLToPath(new URL("./linuxMediationWorker.mjs", import.meta.url)),
      ])
    : undefined;
const supervisorImage =
  process.platform === "linux"
    ? installed([
        fileURLToPath(new URL("../../dist/linuxMediationSupervisor.mjs", import.meta.url)),
        fileURLToPath(new URL("./linuxMediationSupervisor.mjs", import.meta.url)),
      ])
    : undefined;

function privateAsset(directory: string, name: string, image: Buffer, mode: number): string {
  const digest = createHash("sha256").update(image).digest("hex");
  const path = join(directory, `${name}-${digest}`);
  try {
    writeFileSync(path, image, { flag: "wx", mode });
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error;
  }
  const identity = lstatSync(path);
  if (
    !identity.isFile() ||
    identity.nlink !== 1 ||
    identity.uid !== process.getuid?.() ||
    (identity.mode & 0o777) !== mode ||
    createHash("sha256").update(readFileSync(path)).digest("hex") !== digest
  )
    throw new Error("The private Linux mediation runtime changed.");
  return path;
}

function runtime(authority: string): {
  readonly native: string;
  readonly worker: string;
  readonly supervisor: string;
  readonly configurations: string;
  readonly receipts: string;
} {
  if (nativeImage === undefined || workerImage === undefined || supervisorImage === undefined)
    throw new Error("The installed Linux mediation runtime is unavailable.");
  const directory = join(realpathSync(authority), "linux-mediation-runtime");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  const identity = lstatSync(directory);
  if (
    !identity.isDirectory() ||
    identity.uid !== process.getuid?.() ||
    (identity.mode & 0o777) !== 0o700 ||
    realpathSync(directory) !== directory
  )
    throw new Error("The Linux mediation runtime directory is not private.");
  const configurations = join(directory, "configurations");
  const receipts = join(directory, "receipts");
  for (const path of [configurations, receipts]) {
    mkdirSync(path, { recursive: true, mode: 0o700 });
    chmodSync(path, 0o700);
    const child = lstatSync(path);
    if (
      !child.isDirectory() ||
      child.uid !== process.getuid?.() ||
      (child.mode & 0o777) !== 0o700 ||
      realpathSync(path) !== path
    )
      throw new Error("The Linux mediation state directory is not private.");
  }
  return {
    native: privateAsset(directory, "broker", nativeImage, 0o500),
    worker: privateAsset(directory, "worker", workerImage, 0o400),
    supervisor: privateAsset(directory, "supervisor", supervisorImage, 0o400),
    configurations,
    receipts,
  };
}

const availability = new Map<string, { readonly until: number; readonly value: boolean }>();

export function linuxMediationProductionAvailable(authority: string | undefined): boolean {
  if (
    process.platform !== "linux" ||
    process.env.OCTANT_LINUX_MEDIATION_PREVIEW !== "1" ||
    authority === undefined
  )
    return false;
  const cached = availability.get(authority);
  if (cached !== undefined && cached.until > Date.now()) return cached.value;
  let value = false;
  try {
    const installed = runtime(authority);
    value =
      spawnSync(installed.native, ["--check"], {
        timeout: 1_000,
        stdio: "ignore",
      }).status === 0;
  } catch {}
  availability.set(authority, { until: Date.now() + 1_000, value });
  return value;
}

function ownAccountPaths(input: ProcessConfinementPrepareInput): ReadonlyArray<string> {
  const excluded = new Set([resolve(input.boundRoot), resolve(input.temporaryDirectory)]);
  return [
    ...(input.ownAccountPaths ?? []),
    ...(input.privateHomeAllowPaths ?? []),
    ...(input.readRoots ?? []),
    ...(input.additionalWriteRoots ?? []),
  ]
    .map((path) => resolve(path))
    .filter((path, index, paths) => !excluded.has(path) && paths.indexOf(path) === index);
}

export function prepareLinuxMediatedLaunch(
  input: ProcessConfinementPrepareInput,
  selection: SandboxPolicySelection,
  authority: string,
): ConfinedProcessLaunch {
  if (!linuxMediationProductionAvailable(authority))
    throw new Error(
      "Linux access-time protections require explicit host opt-in and a compatible custom kernel; Octant never installs or reboots that kernel.",
    );
  const installed = runtime(authority);
  const policy = {
    ...secretGuardMediationPolicy({
      platform: "linux",
      homeDirectory: homedir(),
      ownAccountPaths: ownAccountPaths(input),
    }),
    readOnlyRoots: [...(input.policyReadOnlyRoots ?? selection.policy.filesystem.readOnlyRoots)],
    protectedPaths: selection.policy.filesystem.protectedPaths.map((entry) => ({
      ...entry,
    })),
  };
  const config: SupervisorConfig = Schema.decodeUnknownSync(LinuxMediationSupervisorConfig)(
    {
      ownerId: randomUUID(),
      maximumMs: LINUX_MEDIATION_PRODUCTION_MAXIMUM_MS,
      receiptDirectory: installed.receipts,
      workerScript: installed.worker,
      nativeExecutable: installed.native,
      launch: input,
      policy,
    },
    { onExcessProperty: "error" },
  );
  const path = join(installed.configurations, `${config.ownerId}.json`);
  writeFileSync(path, JSON.stringify(config), { flag: "wx", mode: 0o600 });
  return {
    command: process.execPath,
    args: [installed.supervisor, path],
    environment: process.versions.electron === undefined ? {} : { ELECTRON_RUN_AS_NODE: "1" },
  };
}
