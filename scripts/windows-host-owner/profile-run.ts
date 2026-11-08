import { generateKeyPairSync } from "node:crypto";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import {
  lstat,
  mkdir,
  readFile,
  writeFile,
  rename,
  rm,
  symlink,
  unlink,
  link,
} from "node:fs/promises";
import { win32 } from "node:path";
import { fileURLToPath } from "node:url";

const identityMode = process.argv[2] === "--server-identity";
const tlsMode = process.argv[2] === "--listener-tls";
const sqliteMode = process.argv[2] === "--sqlite-store";
const authorityMode = process.argv[2] === "--authority-state";
const rosterMode = process.argv[2] === "--roster-key";
const [launcher, binding, fixture, ...runtimes] = process.argv.slice(
  identityMode || tlsMode || rosterMode || authorityMode || sqliteMode ? 3 : 2,
);
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
const signingIdentities = new Map<string, string>();
const tlsPins = new Map<string, string>();
const tlsCertificates = new Map<string, string>();
const rosterFingerprints = new Map<string, string>();
let concurrentReady = 0;
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
    if (
      rosterMode &&
      record(value) &&
      typeof value.profile === "string" &&
      typeof value.rosterFingerprint === "string"
    ) {
      const prior = rosterFingerprints.get(value.profile);
      if (prior !== undefined && prior !== value.rosterFingerprint) {
        invalidOutput = true;
        child.kill();
        return;
      }
      rosterFingerprints.set(value.profile, value.rosterFingerprint);
    }
    if (
      tlsMode &&
      record(value) &&
      typeof value.profile === "string" &&
      typeof value.tlsPin === "string" &&
      typeof value.certificateHash === "string"
    ) {
      const prior = tlsPins.get(value.profile);
      if (prior !== undefined && prior !== value.tlsPin) {
        invalidOutput = true;
        child.kill();
        return;
      }
      tlsPins.set(value.profile, value.tlsPin);
      tlsCertificates.set(value.profile, value.certificateHash);
    }
    if (
      identityMode &&
      record(value) &&
      typeof value.profile === "string" &&
      typeof value.hostKeyFingerprint === "string" &&
      typeof value.hostId === "string"
    ) {
      const identity = `${value.hostId}:${value.hostKeyFingerprint}`;
      const prior = signingIdentities.get(value.profile);
      if (prior !== undefined && prior !== identity) {
        invalidOutput = true;
        child.kill();
        return;
      }
      signingIdentities.set(value.profile, identity);
      if (value.concurrentAdmission === "ready") concurrentReady++;
    }
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
  if (launcher === undefined || fixture === undefined || binding === undefined)
    throw new Error("Missing owned probe inputs.");
  await run(
    launcher,
    ["--profile-user-owner", runtime, fixture, binding, profile, mode],
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
  if (sqliteMode) {
    for (const profile of profiles) await probe(first, profile);
    console.log(
      JSON.stringify({
        sqlitePrototypeLifecycleChecks: [
          "both isolated native profiles commit, checkpoint, reopen and retain foreign read-only consumers",
        ],
        startupAdmitted: false,
        workCodeEnabled: false,
      }),
    );
  } else if (authorityMode) {
    for (const profile of profiles) await probe(first, profile, "missing");
    checks.push("missing reads create nothing and prepare-only processes cannot write");
    for (const runtime of runtimes) await probe(runtime, "octant", "environment-loss");
    checks.push(
      "worker environment loss closes incomplete sessions and refuses cross-environment access",
    );
    for (const runtime of runtimes)
      for (const profile of profiles) {
        await probe(runtime, profile);
        await acl(profile, "authority-inspect");
      }
    checks.push("all three runtime consumers retain private schema-valid authority records");
    const selected = roots[0];
    if (selected === undefined) throw Error("Missing owned state root.");
    const hub = win32.join(selected, "data", "hub");
    const file = win32.join(hub, "hub-state.json");
    const original = await readFile(file);
    try {
      for (const malformed of [
        Buffer.alloc(0),
        Buffer.from("{"),
        Buffer.from([0xff]),
        Buffer.from('{"unexpected":true}'),
      ]) {
        await writeFile(file, malformed);
        await probe(first, "octant", "refuse");
        if (!(await readFile(file)).equals(malformed))
          throw Error("Corrupt authority record was overwritten.");
      }
    } finally {
      await writeFile(file, original);
    }
    checks.push("empty, malformed, invalid UTF-8 and invalid schema records refuse without reset");
    const alias = file + ".alias";
    try {
      await link(file, alias);
      await probe(first, "octant", "refuse");
    } finally {
      await unlink(alias);
    }
    checks.push("hardlinked state refuses");
    await acl("octant", "authority-unsafe");
    try {
      await probe(first, "octant", "refuse");
    } finally {
      await acl("octant", "authority-restore");
    }
    checks.push("exposed state refuses without DACL repair");
    await probe(first, "octant");
    console.log(
      JSON.stringify({
        authorityStateLifecycleChecks: checks,
        startupAdmitted: false,
        workCodeEnabled: false,
      }),
    );
  } else if (rosterMode) {
    const selected = roots[0];
    if (selected === undefined) throw Error("Missing owned roster root.");
    for (const profile of profiles) await probe(first, profile, "missing");
    checks.push("read-only access creates no hub directory or roster key");
    await Promise.all(Array.from({ length: 8 }, () => probe(first, "octant", "concurrent")));
    if (!rosterFingerprints.has("octant"))
      throw Error("Concurrent roster first-use had no successful winner.");
    checks.push("concurrent creation refuses competing writes or retains one roster key");
    for (const runtime of runtimes)
      for (const profile of profiles) {
        await probe(runtime, profile);
        await acl(profile, "roster-inspect");
      }
    if (rosterFingerprints.size !== 2 || new Set(rosterFingerprints.values()).size !== 2)
      throw Error("Roster keys are not profile isolated.");
    checks.push("Bun, Node and Electron retain distinct profile keys across process restarts");
    const hub = win32.join(selected, "data", "hub");
    const key = win32.join(hub, "roster-signing-key.pem");
    const original = await readFile(key);
    try {
      const wrongCurve = generateKeyPairSync("ec", { namedCurve: "P-384" }).privateKey.export({
        format: "pem",
        type: "pkcs8",
      });
      for (const invalid of [
        Buffer.alloc(0),
        Buffer.from("malformed-owned-roster-key"),
        Buffer.alloc(4097, 120),
        Buffer.from(wrongCurve),
      ]) {
        await writeFile(key, invalid);
        await probe(first, "octant", "refuse");
        if (!(await readFile(key)).equals(invalid))
          throw Error("Invalid owned roster key was replaced.");
      }
      await writeFile(key, original);
      checks.push(
        "empty, malformed, oversized and wrong-curve roster keys refuse without replacement",
      );
      const alias = key + ".alias";
      await link(key, alias);
      try {
        await probe(first, "octant", "refuse");
      } finally {
        await unlink(alias);
      }
      checks.push("a hardlinked roster key refuses");
      await rename(key, key + ".original");
      try {
        await mkdir(key);
        await probe(first, "octant", "refuse");
      } finally {
        await rm(key, { recursive: true, force: true });
        await rename(key + ".original", key);
      }
      checks.push("a nonregular roster key refuses");
      await rename(hub, hub + ".original");
      try {
        await symlink(hub + ".original", hub, "junction");
        await probe(first, "octant", "refuse");
      } finally {
        await unlink(hub);
        await rename(hub + ".original", hub);
      }
      checks.push("a reparse replacement for the hub directory refuses");
      await acl("octant", "roster-unsafe");
      try {
        await probe(first, "octant", "refuse");
      } finally {
        await acl("octant", "roster-restore");
      }
      checks.push("an exposed roster key refuses without rewriting its DACL");
      await probe(first, "octant");
      await acl("octant", "roster-inspect");
      checks.push("restored original roster storage remains usable and private");
    } finally {
      original.fill(0);
    }
    console.log(
      JSON.stringify({
        rosterKeyLifecycleChecks: checks,
        startupAdmitted: false,
        workCodeEnabled: false,
      }),
    );
  } else if (tlsMode) {
    const selected = roots[0];
    if (selected === undefined) throw Error("Missing owned TLS root.");
    for (const profile of profiles) await probe(first, profile, "missing");
    checks.push("read-only TLS access creates no remote directory, key or certificate");
    await Promise.all(Array.from({ length: 8 }, () => probe(first, "octant", "concurrent")));
    if (!tlsPins.has("octant")) throw Error("Concurrent TLS first-use had no successful winner.");
    checks.push("concurrent TLS first-use refuses competing writes or retains one pinned key");
    for (const runtime of runtimes)
      for (const profile of profiles) {
        await probe(runtime, profile);
        await acl(profile, "tls-inspect");
      }
    if (tlsPins.size !== 2 || new Set(tlsPins.values()).size !== 2)
      throw Error("TLS keys are not profile isolated.");
    checks.push("all three runtimes preserve two isolated pins across process restarts");
    const beforeRenewal = tlsCertificates.get("octant");
    await probe(first, "octant", "renew");
    if (beforeRenewal === undefined || tlsCertificates.get("octant") === beforeRenewal)
      throw Error("The due certificate was not renewed.");
    checks.push("certificate renewal changes the certificate while retaining the key pin");
    const remote = win32.join(selected, "data", "remote");
    const key = win32.join(remote, "private-listener-tls-key.pem");
    const certificate = win32.join(remote, "private-listener-tls-cert.pem");
    const original = await readFile(key);
    try {
      const wrongCurve = generateKeyPairSync("ec", { namedCurve: "P-384" }).privateKey.export({
        format: "pem",
        type: "pkcs8",
      });
      for (const invalid of [
        Buffer.alloc(0),
        Buffer.from("malformed-owned-tls-key"),
        Buffer.alloc(4097, 120),
        Buffer.from(wrongCurve),
      ]) {
        await writeFile(key, invalid);
        await probe(first, "octant", "refuse");
        if (!(await readFile(key)).equals(invalid))
          throw Error("Invalid owned TLS key was replaced.");
      }
      await writeFile(key, original);
      checks.push(
        "empty, malformed, oversized and wrong-curve TLS keys refuse without replacement",
      );
      await writeFile(certificate, "malformed-owned-certificate");
      await probe(first, "octant");
      checks.push("a corrupt private regular certificate renews with the same pinned key");
      for (const file of [key, certificate]) {
        const alias = file + ".alias";
        await link(file, alias);
        try {
          await probe(first, "octant", "refuse");
        } finally {
          await unlink(alias);
        }
        await rename(file, file + ".original");
        try {
          await mkdir(file);
          await probe(first, "octant", "refuse");
        } finally {
          await rm(file, { recursive: true, force: true });
          await rename(file + ".original", file);
        }
      }
      checks.push("hardlinked or nonregular TLS keys and certificates refuse");
      await rename(remote, remote + ".original");
      try {
        await symlink(remote + ".original", remote, "junction");
        await probe(first, "octant", "refuse");
      } finally {
        await unlink(remote);
        await rename(remote + ".original", remote);
      }
      checks.push("a reparse replacement for the TLS directory refuses");
      await acl("octant", "tls-unsafe");
      try {
        await probe(first, "octant", "exposed");
      } finally {
        await acl("octant", "tls-restore");
      }
      await acl("octant", "tls-cert-unsafe");
      try {
        await probe(first, "octant", "refuse");
      } finally {
        await acl("octant", "tls-cert-restore");
      }
      checks.push("exposed key or certificate DACLs refuse without replacement");
      await probe(first, "octant");
      await acl("octant", "tls-inspect");
      checks.push("restored original TLS storage remains usable and privately owned");
    } finally {
      original.fill(0);
    }
    console.log(
      JSON.stringify({
        listenerTlsLifecycleChecks: checks,
        startupAdmitted: false,
        workCodeEnabled: false,
      }),
    );
  } else if (identityMode) {
    const selected = roots[0];
    if (selected === undefined) throw new Error("Missing owned identity root.");
    for (const profile of profiles) await probe(first, profile, "missing");
    checks.push("read-only signing leaves both profiles without identity records");
    await Promise.all(Array.from({ length: 8 }, () => probe(first, "octant", "concurrent")));
    if (concurrentReady === 0) throw new Error("Concurrent first-use had no successful signer.");
    checks.push("concurrent first-use refuses competing writes or preserves one actual winner");
    for (const runtime of runtimes)
      for (const profile of profiles) {
        await probe(runtime, profile, "normal");
        await acl(profile, "identity-inspect");
      }
    if (signingIdentities.size !== 2 || new Set(signingIdentities.values()).size !== 2)
      throw new Error("Signing identities are not profile isolated.");
    checks.push("Bun, Node and Electron preserve both profile identities across process restarts");
    const remote = win32.join(selected, "data", "remote");
    const key = win32.join(remote, "private-listener-host-key.pem");
    const id = win32.join(remote, "private-listener-host-id");
    const originalKey = await readFile(key);
    const originalId = await readFile(id);
    try {
      const wrongCurve = generateKeyPairSync("ec", { namedCurve: "P-384" }).privateKey.export({
        format: "pem",
        type: "pkcs8",
      });
      for (const invalid of [
        Buffer.alloc(0),
        Buffer.from("malformed-owned-key"),
        Buffer.alloc(4097, 120),
        Buffer.from(wrongCurve),
      ]) {
        await writeFile(key, invalid);
        await probe(first, "octant", "refuse");
        if (!(await readFile(key)).equals(invalid))
          throw new Error("Invalid owned key was changed.");
      }
      await writeFile(key, originalKey);
      await writeFile(id, "invalid-owned-host-id");
      await probe(first, "octant", "refuse");
      if ((await readFile(id)).toString() !== "invalid-owned-host-id")
        throw new Error("Invalid host id was changed.");
      await writeFile(id, originalId);
      checks.push(
        "empty, malformed, oversized, wrong-curve keys and malformed ids refuse without replacement",
      );
      const alias = key + ".alias";
      await link(key, alias);
      try {
        await probe(first, "octant", "refuse");
      } finally {
        await unlink(alias);
      }
      checks.push("a hardlinked private key refuses");
      await rename(key, key + ".original");
      try {
        await mkdir(key);
        await probe(first, "octant", "refuse");
      } finally {
        await rm(key, { recursive: true, force: true });
        await rename(key + ".original", key);
      }
      checks.push("a directory in place of a private key refuses");
      await rename(remote, remote + ".original");
      try {
        await symlink(remote + ".original", remote, "junction");
        await probe(first, "octant", "refuse");
      } finally {
        await unlink(remote);
        await rename(remote + ".original", remote);
      }
      checks.push("a reparse replacement for the identity directory refuses");
      await acl("octant", "identity-unsafe");
      try {
        await probe(first, "octant", "refuse");
      } finally {
        await acl("octant", "identity-restore");
      }
      checks.push("an extra key-file Everyone grant refuses without narrowing it");
      await probe(first, "octant", "normal");
      checks.push("restoring the exact owned records retains the original identity");
    } finally {
      originalKey.fill(0);
      originalId.fill(0);
    }
    console.log(
      JSON.stringify({
        serverIdentityLifecycleChecks: checks,
        startupAdmitted: false,
        workCodeEnabled: false,
      }),
    );
  } else {
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
    const originalDataIdentity = await lstat(data, { bigint: true });
    await rename(data, data + ".original");
    try {
      await acl("octant", "prepare-data");
      const replacement = await lstat(data, { bigint: true });
      if (
        originalDataIdentity.ino === 0n ||
        replacement.ino === 0n ||
        (originalDataIdentity.ino === replacement.ino &&
          originalDataIdentity.dev === replacement.dev)
      )
        throw new Error("The owned replacement is not a different physical directory.");
      await probe(first, "octant", "refuse");
      if (!(await readFile(recordPath)).equals(original))
        throw new Error("Refused replacement changed persistent metadata.");
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
  }
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
