import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { arch, cpus, release, tmpdir, totalmem } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  appOutputContext,
  cleanupPackagedProcess,
  coldLaunchPhases,
  collectHostInteractionMarks,
  readHostStartupTimes,
  sanitizedPackagedEnvironment,
  spawnPackagedApplication,
  stagePackagedAppBundle,
} from "./packaged-smoke-process";

const count = Number(process.argv[2] ?? "15");
if (process.platform !== "darwin" || !Number.isInteger(count) || count < 1 || count > 30) {
  throw new Error("Run on macOS with a sample count between 1 and 30.");
}
const root = await mkdtemp(join(tmpdir(), "octant-launch-measurement."));
const controller = new AbortController();
const stop = () => controller.abort();
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
const cold: ReadonlyArray<Sample>[] = [];
const warm: ReadonlyArray<Sample>[] = [];
type Sample = { readonly phase: string; readonly value: number };

try {
  const bundle = stagePackagedAppBundle(resolve(process.argv[3] ?? "out/Octant.app"));
  const executable = join(bundle, "Contents/MacOS/Octant");
  console.log(
    JSON.stringify({
      machine: {
        model: execFileSync("/usr/sbin/sysctl", ["-n", "hw.model"], { encoding: "utf8" }).trim(),
        uname: release(),
        cpu: cpus()[0]?.model,
        logicalCpus: cpus().length,
        arch: arch(),
        memoryMiB: totalmem() / 1024 ** 2,
      },
      count,
      notes:
        "Fresh data and tmp on every cold sample; one shared profile after two priming runs for warm samples. No OS cache purge. Bootstrap response is not a paint or interaction measurement.",
    }),
  );
  await launch(executable, "warm-prime", 1);
  await launch(executable, "warm-prime", 2);
  for (let index = 0; index < count; index += 1) {
    cold.push(await launch(executable, "cold", index + 1));
    warm.push(await launch(executable, "warm", index + 1));
  }
  console.log(JSON.stringify({ summary: { cold: summarize(cold), warm: summarize(warm) } }));
} finally {
  try {
    await rm(root, { recursive: true, force: true });
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  }
}

async function launch(executable: string, profile: "cold" | "warm" | "warm-prime", index: number) {
  controller.signal.throwIfAborted();
  const directory = join(root, profile === "cold" ? `cold-${index}` : "warm");
  const dataDirectory = join(directory, "data");
  const temporaryDirectory = join(directory, "tmp");
  const logsDirectory = join(directory, `logs-${profile}-${index}`);
  await mkdir(temporaryDirectory, { recursive: true, mode: 0o700 });
  const port = await freePort();
  const env = {
    ...sanitizedPackagedEnvironment(
      { HOME: process.env.HOME, TMPDIR: temporaryDirectory },
      dataDirectory,
    ),
    OCTANT_SERVER_PORT: String(port),
    OCTANT_LOGS_DIR: logsDirectory,
    OCTANT_PERF_TRACE: "1",
  };
  const launchedAt = Date.now();
  const { child, outputTail } = spawnPackagedApplication({ executable, env });
  const pid = child.pid;
  if (pid === undefined) throw new Error("Packaged app did not start.");
  const marks = collectHostInteractionMarks(child.stderr);
  const finished = new Promise<void>((done) => child.once("exit", () => done()));
  const groupExists = () => {
    try {
      process.kill(-pid, 0);
      return true;
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "ESRCH"
      ) {
        return false;
      }
      throw error;
    }
  };
  const signalGroup = (group: number, signal: "SIGTERM" | "SIGKILL") => {
    if (group !== pid) throw new Error("Unexpected process group.");
    if (groupExists()) process.kill(-group, signal);
  };
  const deadline = Date.now() + 45_000;
  try {
    for (;;) {
      controller.signal.throwIfAborted();
      const current = marks();
      const at = (name: string) => current.find((mark) => mark.name === name)?.at;
      if (at("ready-to-show") !== undefined && at("chat-bootstrap-answered") !== undefined) break;
      if (Date.now() > deadline || child.exitCode !== null || child.signalCode !== null) {
        throw new Error(
          `Launch ${profile}/${index} did not reach bootstrap.${appOutputContext(outputTail)}`,
        );
      }
      await delay(25, undefined, { signal: controller.signal });
    }
    const rssKiB = groupRssKiB(pid);
    const observations = marks();
    const phaseSamples = coldLaunchPhases({
      launchedAt,
      marks: observations,
      ...(await readHostStartupTimes({ dataDirectory, logsDirectory })),
    }).flatMap(({ phase, sinceLaunchMs }) =>
      sinceLaunchMs === undefined ? [] : [{ phase, value: sinceLaunchMs }],
    );
    for (const phase of ["host-running", "renderer-preconnect-started", "window-create-start"]) {
      const mark = observations.find((candidate) => candidate.name === phase);
      if (mark === undefined) throw new Error(`Launch ${profile}/${index} lacked ${phase}.`);
      phaseSamples.push({ phase, value: mark.at - launchedAt });
    }
    phaseSamples.push({ phase: "process-group RSS MiB", value: rssKiB / 1024 });
    console.log(JSON.stringify({ profile, index, samples: phaseSamples }));
    return phaseSamples;
  } finally {
    await cleanupPackagedProcess({
      child,
      requestQuit: async () => signalGroup(pid, "SIGTERM"),
      waitForExit: async (_child, timeoutMs) => {
        const timer = new AbortController();
        try {
          return await Promise.race([
            finished.then(() => true),
            delay(timeoutMs, false, { signal: timer.signal }),
          ]);
        } finally {
          timer.abort();
        }
      },
      signalGroup,
      waitForServerCleanup: async () => {
        const cutoff = Date.now() + 5_000;
        while (groupExists() && Date.now() < cutoff) await delay(50);
        if (groupExists()) signalGroup(pid, "SIGKILL");
      },
      assertNoProcesses: async () => {
        const cutoff = Date.now() + 2_000;
        while (groupExists() && Date.now() < cutoff) await delay(25);
        if (groupExists()) throw new Error(`Owned launch group ${pid} is still running.`);
      },
    });
  }
}

function groupRssKiB(pid: number): number {
  let rss = 0;
  for (const line of execFileSync("/bin/ps", ["-axo", "pgid=,rss="], {
    encoding: "utf8",
    timeout: 2_000,
  }).split("\n")) {
    const [group, kiloBytes] = line.trim().split(/\s+/).map(Number);
    if (group === pid && kiloBytes !== undefined) rss += kiloBytes;
  }
  if (rss === 0) throw new Error("Could not find the app's process group.");
  return rss;
}

function summarize(runs: ReadonlyArray<ReadonlyArray<Sample>>) {
  const groups = new Map<string, number[]>();
  for (const run of runs) {
    for (const { phase, value } of run) {
      const values = groups.get(phase) ?? [];
      values.push(value);
      groups.set(phase, values);
    }
  }
  return Object.fromEntries(
    [...groups].map(([phase, values]) => {
      values.sort((a, b) => a - b);
      return [
        phase,
        {
          samples: values.length,
          p50: values[Math.ceil(0.5 * values.length) - 1],
          p95: values[Math.ceil(0.95 * values.length) - 1],
        },
      ];
    }),
  );
}

async function freePort(): Promise<number> {
  const socket = createServer();
  await new Promise<void>((done, fail) => {
    socket.once("error", fail);
    socket.listen(0, "127.0.0.1", done);
  });
  const address = socket.address();
  await new Promise<void>((done, fail) => socket.close((error) => (error ? fail(error) : done())));
  if (address === null || typeof address === "string") throw new Error("Missing loopback port.");
  return address.port;
}
