import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { rm, lstat } from "node:fs/promises";
import { win32 } from "node:path";
import { createInterface } from "node:readline";

const runtime = process.argv[2];
const fixture = process.argv[3];
const binding = process.argv[4];
const launcher = process.argv[5];
if (
  process.platform !== "win32" ||
  runtime === undefined ||
  fixture === undefined ||
  binding === undefined ||
  launcher === undefined ||
  !win32.isAbsolute(launcher) ||
  win32.basename(launcher) !== "octant-windows-owner-reader.exe"
)
  throw new Error("Supply the four owned fixture paths on Windows.");
const local = process.env.LOCALAPPDATA;
if (local === undefined) throw new Error("No local fixture profile.");
const parent = win32.resolve(local, "Octant", "runtime").toLowerCase();
const roots = new Set<string>();
function ownScope(scope: string) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(scope))
    throw new Error("Invalid owned fixture scope.");
  for (const suffix of ["", ".original", ".moved"]) roots.add(win32.join(parent, scope + suffix));
}
const initialScope = randomUUID();
ownScope(initialScope);
const args = runtime.toLowerCase().includes("bun.exe")
  ? [fixture, binding, "parent", initialScope]
  : ["--expose-gc", fixture, binding, "parent", initialScope];
const child = spawn(launcher, [runtime, ...args], {
  stdio: ["ignore", "pipe", "inherit"],
  env: { ...process.env },
  windowsHide: true,
});
const deadline = setTimeout(() => child.kill(), 45_000);
createInterface({ input: child.stdout }).on("line", (line) => {
  const parsed: unknown = JSON.parse(line);
  if (
    typeof parsed === "object" &&
    parsed !== null &&
    "fixtureScope" in parsed &&
    typeof parsed.fixtureScope === "string"
  ) {
    ownScope(parsed.fixtureScope);
    return;
  }
  if (
    typeof parsed === "object" &&
    parsed !== null &&
    "fixtureRoots" in parsed &&
    Array.isArray(parsed.fixtureRoots)
  ) {
    for (const value of parsed.fixtureRoots) {
      if (typeof value !== "string") throw new Error("Invalid fixture cleanup path.");
      const absolute = win32.normalize(value.replace(/^\\\\\?\\/, ""));
      if (
        win32.dirname(absolute).toLowerCase() !== parent ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?:\.(?:original|moved))?$/.test(
          win32.basename(absolute),
        )
      )
        throw new Error("Cleanup path is outside the owned fixture namespace.");
      roots.add(absolute);
    }
  } else console.log(line);
});
let code: number | null = null;
let cleanupFailure = false;
try {
  code = await new Promise<number | null>((resolve, reject) => {
    child.once("error", () => reject(new Error("Fixture process did not start.")));
    child.once("close", resolve);
  });
} finally {
  clearTimeout(deadline);
  // Pinned PID/birth guards are released only by actual process death. Remove
  // only the source-owned UUID fixtures after joining that process.
  for (const root of roots) await rm(root, { recursive: true, force: true });
  for (const root of roots) {
    let absent = false;
    try {
      await lstat(root);
    } catch (error) {
      absent =
        typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
    }
    if (!absent) cleanupFailure = true;
  }
}
if (cleanupFailure) throw new Error("Owned native fixture cleanup was not confirmed.");
if (code !== 0) throw new Error("The native owner fixture failed.");
console.log(JSON.stringify({ processJoined: true, ownedFixturePathsAbsent: roots.size }));
