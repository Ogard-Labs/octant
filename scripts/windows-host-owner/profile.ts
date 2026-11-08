import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createWindowsHostStartup } from "../../packages/host-runtime/src/windowsHostStartup";
import { attachWindowsHostRuntimeOwner } from "../../packages/host-runtime/src/windowsHostOwner";
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
    const attached = await attachWindowsHostRuntimeOwner({
      native,
      scope: paths.profileId,
      hostId: paths.profileId,
      wireVersion: "1",
    });
    check(
      attached.status === "attached" &&
        attached.attachment.owner.instanceId === ownership.receipt.instanceId,
      "read-only discovery authenticates the existing actual owner without claiming or releasing it",
    );

    check(
      ownership.receipt.hostId === paths.profileId,
      "runtime receipt uses the persisted control-scope UUID",
    );
    console.log(JSON.stringify({ fixtureScope: paths.profileId }));
    const startup = createWindowsHostStartup(native, paths);
    if (startup === undefined) throw Error("Native startup storage unavailable.");
    check(
      (await startup.servicePolicy.read()).enabled,
      "native startup policy preserves its enabled default",
    );
    await startup.servicePolicy.setEnabled(false);
    check(
      !(await startup.servicePolicy.read()).enabled,
      "native startup policy persists an explicit owner change",
    );
    await startup.servicePolicy.setEnabled(true);
    await startup.logs.append({
      timestamp: new Date().toISOString(),
      level: "info",
      event: "native.ready",
      message: "credential=fixture-private-value",
    });
    check(
      (await startup.logs.read()).entries.every(
        (entry) => !entry.message.includes("fixture-private-value"),
      ),
      "native service logs retain bounded redacted entries",
    );
    const bridgeSecret = "a".repeat(43);
    await startup.writeBridgeSecret(bridgeSecret);
    await startup.writeHostInfo({
      schemaVersion: 1,
      hostId: paths.profileId,
      instanceId: ownership.receipt.instanceId,
      url: "http://127.0.0.1:13773",
      controlEndpoint: ownership.receipt.endpoint,
      serviceMode: "foreground",
      serverVersion: "fixture",
      wireVersion: "1",
      updatedAt: new Date().toISOString(),
    });
    check(
      (await startup.readBridgeSecret()) === bridgeSecret &&
        (await startup.readHostInfo())?.instanceId === ownership.receipt.instanceId,
      "the actual owner publishes native bridge and host discovery projections",
    );
    // A separate process can read during the native rename/flush/close interval;
    // a worker shares the binding's process lock and cannot exercise this race.
    const reader = spawn(
      process.execPath,
      [fileURLToPath(new URL("./publication-reader.mjs", import.meta.url)), binding, profile],
      { stdio: ["pipe", "pipe", "pipe"], windowsHide: true },
    );
    let readerJoined = false;
    const readerExit = new Promise<number | null>((resolve, reject) => {
      reader.once("error", reject);
      reader.once("close", (code) => {
        readerJoined = true;
        resolve(code);
      });
    });
    // Attach rejection handling immediately; a failed spawn must not escape cleanup.
    void readerExit.catch(() => undefined);
    const readerDeadline = setTimeout(() => reader.kill(), 8000);
    reader.stderr.resume();
    try {
      await new Promise<void>((resolve, reject) => {
        reader.stdout.once("data", (bytes: Buffer) => {
          if (bytes.toString("utf8").trim() === "publication-reader-ready") resolve();
          else reject(Error("Owned publication reader did not become ready."));
        });
        void readerExit.then(
          () => reject(Error("Owned publication reader exited before readiness.")),
          reject,
        );
      });
      for (let publication = 0; publication < 128; publication++) {
        const receipt = await startup.readHostInfo();
        if (receipt === undefined) throw Error("Owned publication record disappeared.");
        await startup.writeHostInfo({ ...receipt, serverVersion: `fixture-${publication}` });
      }
      reader.stdin.end();
      check(
        (await readerExit) === 0,
        "independent native readers observe complete snapshots throughout atomic publication",
      );
    } finally {
      reader.stdin.end();
      if (!readerJoined) reader.kill();
      await readerExit.catch(() => undefined);
      clearTimeout(readerDeadline);
    }
    await startup.clearProjections({ instanceId: randomUUID() });
    check(
      (await startup.readHostInfo())?.instanceId === ownership.receipt.instanceId,
      "cleanup preserves a different owner's generation",
    );
    const clearing = startup.clearProjections({
      instanceId: ownership.receipt.instanceId,
      bridgeSecret,
    });
    const newerInstance = randomUUID();
    const newerBridge = "b".repeat(43);
    await startup.writeHostInfo({
      schemaVersion: 1,
      hostId: paths.profileId,
      instanceId: newerInstance,
      url: "http://127.0.0.1:13773",
      controlEndpoint: ownership.receipt.endpoint,
      serviceMode: "foreground",
      serverVersion: "fixture",
      wireVersion: "1",
      updatedAt: new Date().toISOString(),
    });
    await startup.writeBridgeSecret(newerBridge);
    await clearing;
    check(
      (await startup.readHostInfo())?.instanceId === newerInstance &&
        (await startup.readBridgeSecret()) === newerBridge,
      "old cleanup cannot remove new projections published while its promise is pending",
    );
    await startup.clearProjections({ instanceId: newerInstance, bridgeSecret: newerBridge });

    check(
      (await startup.readBridgeSecret()) === undefined &&
        (await startup.readHostInfo()) === undefined,
      "owner-bound native cleanup removes only matching bridge and host projections",
    );

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
    check(
      (await startup.servicePolicy.read()).enabled,
      "native discovery can read policy without claiming an owner",
    );
    let refusedWrite = false;
    try {
      await startup.servicePolicy.setEnabled(false);
    } catch {
      refusedWrite = true;
    }
    check(refusedWrite, "native policy mutation refuses after owner release");
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
