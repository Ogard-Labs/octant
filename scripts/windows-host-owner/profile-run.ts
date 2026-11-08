import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import {
  lstat,
  readFile,
  writeFile,
  rename,
  rm,
  symlink,
  unlink,
  link,
  mkdir,
} from "node:fs/promises";
import { win32 } from "node:path";
import { fileURLToPath } from "node:url";

const [launcher, binding, fixture, ...runtimes] = process.argv.slice(2);
if (process.platform !== "win32" || !launcher || !binding || !fixture || runtimes.length !== 3)
  throw new Error("Supply the owned launcher, binding, fixture and three runtimes.");
const children = new Set<ChildProcess>();
const queryExecutable = win32.join(
  process.env.SystemRoot ?? "C:\\Windows",
  "System32",
  "WindowsPowerShell",
  "v1.0",
  "powershell.exe",
);
const local = await new Promise<string>((resolve, reject) => {
  const child = execFile(
    queryExecutable,
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      '[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); [Console]::WriteLine([Environment]::GetFolderPath("LocalApplicationData"))',
    ],
    {
      timeout: 8_000,
      killSignal: "SIGKILL",
      maxBuffer: 32768,
      windowsHide: true,
      env: Object.fromEntries(
        Object.entries(process.env).filter(([name]) => name.toLowerCase() !== "psmodulepath"),
      ),
    },
    (error, stdout) => {
      children.delete(child);
      if (error !== null) reject(new Error("The independent native known-folder query failed."));
      else resolve(stdout.trim());
    },
  );
  children.add(child);
});
if (!/^[a-z]:\\/i.test(local) || local.includes("\0") || win32.normalize(local) !== local)
  throw new Error("The native fixture known folder is unavailable.");
const environmentLocal = process.env.LOCALAPPDATA;
if (
  environmentLocal !== undefined &&
  win32.normalize(environmentLocal).toLowerCase() !== local.toLowerCase()
) {
  console.log(
    JSON.stringify({
      fixtureKnownFolderMismatchRefused: true,
      knownFolderQueryProcessJoined: true,
    }),
  );
  process.exit(2);
}
const hosts = win32.resolve(local, "Octant", "hosts");
const transient = win32.resolve(local, "Octant", "runtime");
const profiles = ["octant", "nightly-test-data"] as const;
const roots = profiles.map((profile) => win32.join(hosts, profile));
const cleanup = new Set<string>();
const identities = new Map<string, string>();
const checks: string[] = [];
let allJobsJoined = true;
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
async function absent(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return false;
  } catch (error) {
    if (record(error) && error.code === "ENOENT") return true;
    throw error;
  }
}
// Never inspect or remove a pre-existing host profile, even on disposable CI.
for (const root of roots)
  if (!(await absent(root))) throw new Error("The owned profile fixture is not empty.");
for (const root of roots) {
  cleanup.add(root);
  cleanup.add(root + ".original");
  cleanup.add(root + ".moved");
}
const deadline = setTimeout(() => {
  for (const child of children) child.kill();
}, 240_000);
async function run(
  executable: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  limit: number,
): Promise<void> {
  const child = spawn(executable, args, {
    env,
    stdio: ["ignore", "pipe", "inherit"],
    windowsHide: true,
  });
  children.add(child);
  let joined = false;
  let invalidOutput = false;
  createInterface({ input: child.stdout }).on("line", (line) => {
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      invalidOutput = true;
      child.kill();
      return;
    }
    if (record(value) && value.ownedJobJoined === true) joined = true;
    if (record(value) && typeof value.fixtureScope === "string") {
      if (
        !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
          value.fixtureScope,
        )
      ) {
        invalidOutput = true;
        child.kill();
        return;
      }
      cleanup.add(win32.join(transient, value.fixtureScope));
    } else {
      if (
        record(value) &&
        typeof value.profile === "string" &&
        typeof value.profileId === "string"
      ) {
        const previous = identities.get(value.profile);
        if (previous !== undefined && previous !== value.profileId) {
          invalidOutput = true;
          child.kill();
          return;
        }
        identities.set(value.profile, value.profileId);
      }
      console.log(line);
    }
  });
  const timer = setTimeout(() => child.kill(), limit);
  try {
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once("error", () => reject(new Error("Owned profile fixture did not start.")));
      child.once("close", resolve);
    });
    if (code !== 0 || invalidOutput) throw new Error("Owned profile fixture failed.");
    if (executable === launcher && !joined)
      throw new Error("Owned restricted job did not confirm cleanup.");
  } finally {
    if (executable === launcher && !joined) allJobsJoined = false;
    clearTimeout(timer);
    children.delete(child);
  }
}
const first = runtimes[0];
if (first === undefined) throw new Error("Missing owned runtime.");
async function probe(runtime: string, profile: string, mode = "normal") {
  await run(
    launcher,
    [runtime, fixture, binding, profile, mode],
    {
      ...process.env,
      ...(runtime.toLowerCase().endsWith("electron.exe") ? { ELECTRON_RUN_AS_NODE: "1" } : {}),
    },
    45_000,
  );
}
async function acl(profile: string, mode: string) {
  const executable = win32.join(
    process.env.SystemRoot ?? "C:\\Windows",
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => name.toLowerCase() !== "psmodulepath"),
  );
  await run(
    executable,
    [
      "-NoProfile",
      "-NonInteractive",
      "-File",
      fileURLToPath(new URL("./profile-fixtures.ps1", import.meta.url)),
      "-Profile",
      profile,
      "-Mode",
      mode,
    ],
    env,
    10_000,
  );
}
let runFailure: unknown;
try {
  for (const profile of profiles) {
    await run(first, [fixture, binding, profile, "refuse"], { ...process.env }, 30_000);
    for (const root of roots)
      if (!(await absent(root)))
        throw new Error("Refused default-owner context mutated a profile.");
  }
  checks.push("the original administrator default-owner context refuses before profile creation");
  for (const runtime of runtimes) {
    for (const profile of profiles) {
      await probe(runtime, profile);
      await acl(profile, "inspect");
    }
  }
  if (identities.size !== 2 || new Set(identities.values()).size !== 2)
    throw new Error("Profile identities are not isolated.");
  checks.push("both closed profiles persist independently across Bun, Node and Electron");
  const stable = roots[0];
  const nightly = roots[1];
  if (stable === undefined || nightly === undefined) throw new Error("Missing owned profiles.");
  const recordPath = win32.join(stable, "profile.bin");
  const original = await readFile(recordPath);
  await writeFile(recordPath, Buffer.from("malformed-owned-fixture"));
  await probe(first, "octant", "refuse");
  if (!(await readFile(recordPath)).equals(Buffer.from("malformed-owned-fixture")))
    throw new Error("Malformed identity was silently replaced.");
  await writeFile(recordPath, original);
  checks.push("malformed identity refuses without regeneration");

  const otherRecord = win32.join(nightly, "profile.bin");
  const other = await readFile(otherRecord);
  await writeFile(otherRecord, original);
  await probe(first, "nightly-test-data", "refuse");
  await writeFile(otherRecord, other);
  checks.push("another profile's identity cannot be transplanted");

  const alias = win32.join(stable, "alias.bin");
  await link(recordPath, alias);
  await probe(first, "octant", "refuse");
  await unlink(alias);
  checks.push("hardlinked profile metadata refuses");

  await acl("octant", "unsafe");
  await probe(first, "octant", "refuse");
  await acl("octant", "restore");
  checks.push("a profile with an additional Everyone grant refuses");

  for (const target of [stable, win32.join(stable, "data")]) {
    const originalPath = target + ".original";
    await rename(target, originalPath);
    try {
      await symlink(originalPath, target, "junction");
      try {
        await probe(first, "octant", "refuse");
      } finally {
        await unlink(target);
      }
    } finally {
      await rename(originalPath, target);
    }
  }
  checks.push("profile and data reparse replacements refuse");

  const data = win32.join(stable, "data");
  await rename(data, data + ".original");
  try {
    await mkdir(data);
    await acl("octant", "seal-data");
    await probe(first, "octant", "refuse");
  } finally {
    await rm(data, { recursive: true, force: true });
    await rename(data + ".original", data);
  }
  checks.push(
    "an ordinary replacement with a correct private DACL still fails physical data identity",
  );
  await probe(first, "octant");
  checks.push("restored physical data and profile identities remain usable");
  console.log(
    JSON.stringify({
      profileLifecycleChecks: checks,
      startupAdmitted: false,
      workCodeEnabled: false,
    }),
  );
} catch (error) {
  runFailure = error;
} finally {
  clearTimeout(deadline);
}
if (children.size !== 0 || !allJobsJoined) {
  console.log(JSON.stringify({ ownedProfileProcessesJoined: false }));
  throw new Error("Owned fixture processes have not confirmed cleanup.");
}
{
  for (const path of cleanup) await rm(path, { recursive: true, force: true });
  for (const path of cleanup)
    if (!(await absent(path))) throw new Error("Owned profile cleanup was not confirmed.");
  console.log(
    JSON.stringify({ ownedProfileProcessesJoined: true, ownedFixturePathsAbsent: cleanup.size }),
  );
}
if (runFailure !== undefined) throw runFailure;
