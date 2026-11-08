import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

if (process.platform !== "darwin") throw Error("Run this native fixture on isolated macOS.");
const output = process.env.OCTANT_QA_OUTPUT;
if (output === undefined) throw Error("Supply the owned evidence folder.");
await mkdir(output, { recursive: true });
const work = await mkdtemp(join(tmpdir(), "octant-child-browser-native-"));
await mkdir(join(work, "home"));
const binary = resolve("node_modules/electron/dist/Electron.app/Contents/MacOS/Electron");
const main = join(work, "main.mjs");
const build = await Bun.build({
  entrypoints: [resolve("scripts/browser-child-native-qa-main.ts")],
  target: "node",
  format: "esm",
  external: ["electron"],
  outdir: work,
  naming: "main.mjs",
});
if (!build.success) throw Error("The native fixture could not be bundled.");
const child = spawn(binary, [main], {
  detached: true,
  env: {
    PATH: process.env.PATH,
    HOME: join(work, "home"),
    TMPDIR: work,
    OCTANT_CHILD_QA_ROOT: work,
    OCTANT_QA_OUTPUT: output,
    ...(process.env.RUNNER_TRACKING_ID === undefined
      ? {}
      : { RUNNER_TRACKING_ID: process.env.RUNNER_TRACKING_ID }),
  },
  stdio: ["pipe", "pipe", "pipe"],
});
let receipt = "";
let error = "";
child.stdout.on("data", (chunk: Buffer) => {
  receipt += chunk.toString();
});
child.stderr.on("data", (chunk: Buffer) => {
  error = (error + chunk.toString()).slice(-3000);
});
const stop = () => {
  if (child.pid !== undefined && child.exitCode === null && child.signalCode === null) {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      /* The owned process may already have exited. */
    }
  }
};
const timer = setTimeout(stop, 150_000);
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
let exitCode: number | null = null;
try {
  exitCode = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  if (child.pid !== undefined) {
    const rows = execFileSync("/bin/ps", ["-axo", "pid=,pgid="], {
      encoding: "utf8",
      timeout: 3000,
    });
    if (rows.split("\n").some((row) => Number(row.trim().split(/\s+/)[1]) === child.pid))
      throw Error("The owned Electron process group still has a member.");
  }
  if (exitCode !== 0) {
    await writeFile(join(output, "native-failure.txt"), error);
    throw Error("The native managed-child Browser check failed; see bounded failure evidence.");
  }
  const lines = receipt
    .split("\n")
    .filter((line) => line.startsWith('{"check":"browser-managed-child-native"'));
  if (lines.length !== 1) throw Error("The native fixture returned no unique result.");
  await writeFile(join(output, "native-child-evidence.json"), lines[0] ?? "");
  console.log(lines[0]);
} finally {
  clearTimeout(timer);
  process.removeListener("SIGINT", stop);
  process.removeListener("SIGTERM", stop);
  stop();
  await rm(work, { recursive: true, force: true });
}
