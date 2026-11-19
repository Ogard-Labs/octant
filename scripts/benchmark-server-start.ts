import { execFileSync, spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { arch, cpus, release, tmpdir, totalmem } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

// Time from spawning the built host to /health answering with ready storage,
// with Node's compile cache cold (a new data folder each run) and cached (one
// shared folder primed twice). Every run stops with SIGTERM and waits for the
// exit, so no run starts beside a stale owner left by the one before.
const count = Number(process.argv[2] ?? "15");
const dist = resolve(process.argv[3] ?? "apps/server/dist");
// Resolved once here: the host's own environment below carries no PATH to it.
const node = execFileSync(process.argv[4] ?? "node", ["-p", "process.execPath"], {
  encoding: "utf8",
}).trim();
if (!Number.isInteger(count) || count < 1 || count > 30) {
  throw new Error("Usage: bun scripts/benchmark-server-start.ts [count 1-30] [dist] [node]");
}
const root = await mkdtemp(join(tmpdir(), "octant-server-start."));
try {
  console.log(
    JSON.stringify({
      machine: {
        uname: release(),
        cpu: cpus()[0]?.model,
        logicalCpus: cpus().length,
        arch: arch(),
        memoryMiB: totalmem() / 1024 ** 2,
      },
      node: execFileSync(node, ["--version"], { encoding: "utf8" }).trim(),
      count,
      dist,
    }),
  );
  const cachedDirectory = join(root, "cached");
  await start(cachedDirectory);
  await start(cachedDirectory);
  const cold: Sample[] = [];
  const cached: Sample[] = [];
  for (let index = 0; index < count; index += 1) {
    const coldDirectory = join(root, `cold-${index}`);
    cold.push(await start(coldDirectory));
    await rm(coldDirectory, { recursive: true, force: true });
    cached.push(await start(cachedDirectory));
  }
  console.log(JSON.stringify({ summary: { cold: summarize(cold), cached: summarize(cached) } }));
} finally {
  await rm(root, { recursive: true, force: true });
}

interface Sample {
  readonly readyMs: number;
  readonly rssMiB: number;
}

async function start(dataDirectory: string): Promise<Sample> {
  const port = await freePort();
  const started = performance.now();
  const child = spawn(node, [join(dist, "main.mjs")], {
    env: {
      ...(process.env.HOME === undefined ? {} : { HOME: process.env.HOME }),
      ...(process.env.TMPDIR === undefined ? {} : { TMPDIR: process.env.TMPDIR }),
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
      OCTANT_DATA_DIR: dataDirectory,
      OCTANT_SERVER_PORT: String(port),
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let output = "";
  child.stderr.on("data", (chunk: Buffer) => {
    output = (output + chunk.toString("utf8")).slice(-4_000);
  });
  const exited = new Promise<void>((done) => {
    child.once("exit", () => done());
    child.once("error", () => done());
  });
  try {
    const deadline = Date.now() + 30_000;
    for (;;) {
      if (child.exitCode !== null || Date.now() > deadline) {
        throw new Error(`The host did not become ready.\n${output}`);
      }
      const body = await fetch(`http://127.0.0.1:${port}/health`)
        .then((response) => (response.ok ? response.json() : undefined))
        .catch(() => undefined);
      if (
        typeof body === "object" &&
        body !== null &&
        "storage" in body &&
        body.storage === "ready"
      ) {
        break;
      }
      await delay(5);
    }
    const readyMs = performance.now() - started;
    const rssKiB = Number(
      execFileSync("/bin/ps", ["-o", "rss=", "-p", String(child.pid)], { encoding: "utf8" }).trim(),
    );
    return { readyMs, rssMiB: rssKiB / 1024 };
  } finally {
    child.kill("SIGTERM");
    await exited;
  }
}

function summarize(samples: ReadonlyArray<Sample>) {
  const stat = (values: number[]) => {
    values.sort((a, b) => a - b);
    return {
      p50: values[Math.ceil(0.5 * values.length) - 1],
      p95: values[Math.ceil(0.95 * values.length) - 1],
    };
  };
  return {
    samples: samples.length,
    readyMs: stat(samples.map((sample) => sample.readyMs)),
    rssMiB: stat(samples.map((sample) => sample.rssMiB)),
  };
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  await new Promise<void>((done) => server.close(() => done()));
  if (address === null || typeof address === "string") throw new Error("No free port.");
  return address.port;
}
