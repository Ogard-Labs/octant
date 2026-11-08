import { lstat, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { win32 } from "node:path";
import { randomUUID } from "node:crypto";
import {
  acquireWindowsHostProfileOwner,
  loadWindowsHostProfileNative,
  type WindowsHostProfile,
} from "../../packages/host-runtime/src/windowsHostProfile";

const binding = win32.resolve(process.argv[2] ?? "");
const selected = process.argv[3];
const mode = process.argv[4];
if (selected !== "octant" && selected !== "nightly-test-data")
  throw new Error("Supply one owned closed profile.");
const profile: WindowsHostProfile = selected;
const native = loadWindowsHostProfileNative(binding);
if (native === undefined) throw new Error("Native persistent profile ABI unavailable.");
const checks: string[] = [];
function check(value: boolean, name: string) {
  if (!value) throw new Error(`Native profile check failed: ${name}`);
  checks.push(name);
}
const lifetime = setTimeout(() => process.exit(2), 25_000);
const options = {
  native,
  profile,
  env: {},
  instanceId: randomUUID(),
  serverVersion: "fixture",
  wireVersion: "1",
  serviceMode: "foreground",
} as const;
let held: Awaited<ReturnType<typeof acquireWindowsHostProfileOwner>> | undefined;
try {
  const cleanupFacts: unknown = native.openProfile(profile);
  if (
    typeof cleanupFacts === "object" &&
    cleanupFacts !== null &&
    "profileId" in cleanupFacts &&
    typeof cleanupFacts.profileId === "string"
  )
    console.log(JSON.stringify({ fixtureScope: cleanupFacts.profileId }));
  held = await acquireWindowsHostProfileOwner(options);
  if (mode === "refuse") {
    check(
      held.status === "refused" && held.reason === "profile-unavailable",
      "unsafe persistent profile refuses before control acquisition",
    );
  } else {
    check(held.status === "ready", "native profile facts acquire the actual scoped control owner");
    if (held.status !== "ready" || held.ownership.kind !== "owner")
      throw new Error("Expected owned persistent fixture.");
    const { paths, ownership } = held;
    check(
      ownership.receipt.hostId === paths.profileId,
      "runtime receipt uses the persisted control-scope UUID",
    );
    console.log(JSON.stringify({ fixtureScope: paths.profileId }));
    const proof = win32.join(paths.dataDirectory, "proof");
    const file = win32.join(proof, "written.txt");
    await mkdir(proof, { recursive: true });
    let previous: string | undefined;
    try {
      previous = await readFile(file, "utf8");
    } catch (error) {
      if (
        typeof error !== "object" ||
        error === null ||
        !("code" in error) ||
        error.code !== "ENOENT"
      )
        throw error;
    }
    if (previous === undefined) await writeFile(file, paths.profileId, { flag: "wx" });
    check(
      (await readFile(file, "utf8")) === paths.profileId,
      "ordinary persistent writes retain the profile identity across runtimes",
    );
    for (const [kind, directory] of [
      ["profile", paths.rootDirectory],
      ["data", paths.dataDirectory],
    ] as const) {
      const before = await lstat(directory);
      let refused = false;
      try {
        await rename(directory, directory + ".moved");
      } catch {
        refused = true;
      }
      let sourcePresent = false;
      let destinationPresent = false;
      let samePhysicalDirectory = false;
      try {
        sourcePresent = (await lstat(directory)).isDirectory();
      } catch (error) {
        if (
          typeof error !== "object" ||
          error === null ||
          !("code" in error) ||
          error.code !== "ENOENT"
        )
          throw error;
      }
      try {
        const after = await lstat(directory + ".moved");
        destinationPresent = after.isDirectory();
        samePhysicalDirectory =
          before.ino !== 0 && before.dev === after.dev && before.ino === after.ino;
      } catch (error) {
        if (
          typeof error !== "object" ||
          error === null ||
          !("code" in error) ||
          error.code !== "ENOENT"
        )
          throw error;
      }
      console.log(
        JSON.stringify({
          heldDirectoryKind: kind,
          renameRejected: refused,
          sourcePresent,
          destinationPresent,
          samePhysicalDirectory,
        }),
      );
      check(refused, "held persistent directory identity cannot be renamed");
    }
    let mutationRefused = false;
    try {
      await writeFile(win32.join(paths.rootDirectory, "profile.bin"), "replaced");
    } catch {
      mutationRefused = true;
    }
    check(mutationRefused, "the held profile metadata cannot be overwritten");
    const original = process.env.LOCALAPPDATA;
    try {
      process.env.LOCALAPPDATA = win32.join(paths.rootDirectory, "unapproved");
      const repeated: unknown = native.openProfile(profile);
      check(
        typeof repeated === "object" &&
          repeated !== null &&
          "profileId" in repeated &&
          repeated.profileId === paths.profileId,
        "the native known folder ignores an environment-selected alternative",
      );
    } finally {
      if (original === undefined) delete process.env.LOCALAPPDATA;
      else process.env.LOCALAPPDATA = original;
    }
    const external = await acquireWindowsHostProfileOwner({
      ...options,
      env: { OCTANT_DATA_DIR: paths.dataDirectory },
    });
    check(
      external.status === "refused" && external.reason === "path-override",
      "explicit external path overrides refuse without selecting another store",
    );
    await ownership.release();
    held = undefined;
    const after = await acquireWindowsHostProfileOwner(options);
    if (after.status === "ready") held = after;
    check(
      after.status === "refused" && after.reason === "owner-unavailable",
      "profile control never takes over its live writer after release",
    );
    console.log(
      JSON.stringify({
        profile,
        profileId: paths.profileId,
        runtime: process.versions,
        checks,
        startupAdmitted: false,
        workCodeEnabled: false,
      }),
    );
  }
} finally {
  if (held?.status === "ready" && held.ownership.kind === "owner") await held.ownership.release();
  native.close();
  clearTimeout(lifetime);
}
