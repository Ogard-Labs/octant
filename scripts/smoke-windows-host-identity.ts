import { spawn } from "node:child_process";
import { createHash, createHmac, randomUUID } from "node:crypto";
import { basename, dirname, join, resolve } from "node:path";
import {
  makeHostIdentitySigningService,
  decodeHostSigningResponse,
} from "../apps/desktop/src/hostIdentityKeychain";
import {
  makeWindowsCredentialStore,
  type WindowsCredentialNamespace,
} from "../packages/host-runtime/src/windowsCredentialStore";

if (process.platform !== "win32" || process.env.GITHUB_ACTIONS !== "true")
  throw new Error("This synthetic fixture requires an owned ephemeral Windows CI runner.");
const helper = resolve(process.argv[2] ?? "");
const fixturePath = resolve(process.argv[3] ?? "");
if (
  basename(helper) !== "octant-credential-helper.exe" ||
  basename(fixturePath) !== "windows-host-identity-fixture.ps1"
)
  throw new Error("Supply the fixed owned native build and QA fixture.");
type Family = "octant" | "octant-nightly-test-data";
const selectedScope = randomUUID();
const otherScope = randomUUID();
const raceScope = randomUUID();
const vectorScope = randomUUID();
const owned = [
  { scope: selectedScope, family: "octant" as const },
  { scope: otherScope, family: "octant" as const },
  { scope: selectedScope, family: "octant-nightly-test-data" as const },
  { scope: raceScope, family: "octant" as const },
  { scope: vectorScope, family: "octant" as const },
];
const service = (scope = selectedScope, family: Family = "octant") =>
  makeHostIdentitySigningService(helper, {
    storeScope: scope,
    serviceFamily: family,
    platform: "win32",
  });
const checks: string[] = [];
const generic: ReturnType<typeof makeWindowsCredentialStore>[] = [];
let fixturesJoined = 0;
let rawHelpersJoined = 0;
let stage = "start";
function check(value: boolean, label: string) {
  if (!value) throw new Error(`Native desktop identity check failed: ${label}`);
  checks.push(label);
}
async function refuses(action: () => Promise<unknown>, category: string) {
  try {
    await action();
  } catch (error) {
    return (
      typeof error === "object" &&
      error !== null &&
      "category" in error &&
      error.category === category
    );
  }
  return false;
}
async function fixture(
  operation: "seed" | "corrupt" | "remove" | "absent",
  scope: string,
  family: Family = "octant",
) {
  return await new Promise<boolean>((accept, refuse) => {
    const environment = { ...process.env };
    delete environment.PSModulePath;
    const powershell = join(
      process.env.SystemRoot ?? "C:\\Windows",
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe",
    );
    const child = spawn(powershell, ["-NoProfile", "-NonInteractive", "-File", fixturePath], {
      env: environment,
      stdio: ["pipe", "pipe", "ignore"],
      windowsHide: true,
    });
    let output = "";
    let failed = false;
    const timer = setTimeout(() => {
      failed = true;
      child.kill();
    }, 12000);
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
      if (output.length > 32) {
        failed = true;
        child.kill();
      }
    });
    child.stdin.on("error", () => {
      failed = true;
      child.kill();
    });
    child.once("error", () => {
      failed = true;
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      fixturesJoined += 1;
      if (failed || code !== 0 || !["true", "false"].includes(output.trim()))
        refuse(new Error("Owned identity fixture failed."));
      else accept(output.trim() === "true");
    });
    child.stdin.end(JSON.stringify({ operation, family, scope }) + "\n");
  });
}
async function raw(input: Buffer) {
  return await new Promise<{ exitCode: number | null; value: unknown }>((accept, refuse) => {
    const child = spawn(helper, [], {
      env: {},
      stdio: ["pipe", "pipe", "ignore"],
      windowsHide: true,
    });
    const chunks: Buffer[] = [];
    let bytes = 0;
    let failed = false;
    const timer = setTimeout(() => {
      failed = true;
      child.kill();
    }, 5000);
    child.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 16384) {
        failed = true;
        child.kill();
      } else chunks.push(chunk);
    });
    child.stdin.on("error", () => {
      failed = true;
      child.kill();
    });
    child.once("error", () => {
      failed = true;
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      rawHelpersJoined += 1;
      const output = Buffer.concat(chunks);
      for (const chunk of chunks) chunk.fill(0);
      try {
        if (failed) throw new Error("Owned native identity probe failed.");
        accept({ exitCode: code, value: JSON.parse(output.toString("utf8")) });
      } catch {
        refuse(new Error("Owned native identity probe failed."));
      } finally {
        output.fill(0);
      }
    });
    child.stdin.end(input);
  });
}

try {
  stage = "generate";
  const primary = service();
  const first = await primary.ensureIdentityKey();
  check(
    /^[0-9a-f]{64}$/.test(first.fingerprint) && Object.keys(first).join(",") === "fingerprint",
    "generated identity exposes only a fingerprint",
  );
  check(
    (await service().ensureIdentityKey()).fingerprint === first.fingerprint,
    "a new controller reads the same persisted identity",
  );
  const payload = Buffer.from("synthetic desktop host proof");
  const signed = await primary.sign(payload);
  check(
    signed.fingerprint === first.fingerprint &&
      Buffer.from(signed.signature, "base64").length === 32 &&
      Object.keys(signed).sort().join(",") === "fingerprint,signature",
    "native signing exposes a fingerprint and32-byte MAC only",
  );
  check(
    (await service().sign(payload)).signature === signed.signature,
    "independent native calls sign with the same stored key",
  );
  check(
    (await primary.sign(Buffer.from("different owned proof"))).signature !== signed.signature,
    "the MAC binds the exact payload",
  );
  const distinct = [
    first.fingerprint,
    (await service(otherScope).ensureIdentityKey()).fingerprint,
    (await service(selectedScope, "octant-nightly-test-data").ensureIdentityKey()).fingerprint,
  ];
  check(new Set(distinct).size === 3, "store and family identities remain distinct");
  const raced = await Promise.all(
    Array.from({ length: 12 }, () => service(raceScope).ensureIdentityKey()),
  );
  check(
    new Set(raced.map((value) => value.fingerprint)).size === 1,
    "concurrent first-use controllers create one persistent identity",
  );

  stage = "known-vector";
  await fixture("seed", vectorScope);
  const known = Buffer.from(Array.from({ length: 32 }, (_, i) => i));
  const expectedFingerprint = createHash("sha256").update(known).digest("hex");
  const expectedSignature = createHmac("sha256", known).update(payload).digest("base64");
  const vector = service(vectorScope);
  check(
    (await vector.ensureIdentityKey("f".repeat(64))).fingerprint === expectedFingerprint,
    "fingerprint hashes the raw32-byte key and legacy proof imports nothing",
  );
  const vectorSigned = await vector.sign(payload);
  check(
    vectorSigned.fingerprint === expectedFingerprint &&
      vectorSigned.signature === expectedSignature,
    "native HMAC-SHA256 agrees with the independent known-key vector",
  );
  const large = Buffer.alloc(4096, 7);
  check(
    (await vector.sign(large)).signature ===
      createHmac("sha256", known).update(large).digest("base64"),
    "signing payloads larger than the credential blob cap retain the existing request bound",
  );
  check(
    await refuses(() => vector.sign(Buffer.alloc(16384)), "invalid"),
    "oversized service payload refuses without replacing the identity",
  );
  known.fill(0);

  stage = "closed-protocol";
  const base = Buffer.alloc(47);
  base.write("OCHI");
  base[4] = 1;
  base[5] = 3;
  base[6] = 0;
  base.write(vectorScope, 7, "ascii");
  const invalid = [Buffer.concat([base, Buffer.from([0])])];
  for (const [offset, value] of [
    [4, 2],
    [5, 0],
    [5, 4],
    [5, 5],
    [5, 6],
    [6, 2],
    [7, 46],
  ]) {
    if (offset === undefined || value === undefined)
      throw new Error("Invalid owned protocol fixture.");
    const frame = Buffer.from(base);
    frame[offset] = value;
    invalid.push(frame);
  }
  const oversized = Buffer.from(base);
  oversized[5] = 2;
  oversized.writeUInt32LE(12289, 43);
  invalid.push(oversized);
  for (const frame of invalid) {
    const result = await raw(frame);
    const value = decodeHostSigningResponse(result.value);
    check(
      result.exitCode === 1 && !value.ok && value.error === "failed",
      "native unsupported or malformed identity operation refuses before mutation",
    );
  }
  check(
    (await vector.sign(payload)).signature === expectedSignature,
    "malformed requests cannot rotate or export the stored identity",
  );

  stage = "namespace-isolation";
  const namespaces: ReadonlyArray<WindowsCredentialNamespace> = [
    "provider",
    "replica-device-key",
    "replica-store-credential",
    "canvas-public-share-secret",
    "mcp-server-credential",
    "desktop-provider-credential",
    "push-platform-credential",
    "ssh-key",
  ];
  for (const namespace of namespaces) {
    const store = makeWindowsCredentialStore({
      helperPath: helper,
      storeScope: vectorScope,
      namespace,
    });
    generic.push(store);
    await store.set(vectorScope, "synthetic-namespace-" + namespace);
  }
  check(
    (await vector.sign(payload)).signature === expectedSignature,
    "generic provider and auxiliary writes cannot replace the native identity",
  );
  const rotated = await vector.rotateIdentityKey();
  check(
    rotated.fingerprint !== expectedFingerprint && Object.keys(rotated).join(",") === "fingerprint",
    "explicit atomic rotation returns only a new fingerprint",
  );
  check(
    (await service(vectorScope).sign(payload)).fingerprint === rotated.fingerprint &&
      (await service(vectorScope).ensureIdentityKey()).fingerprint === rotated.fingerprint,
    "rotation persists across controllers and subsequent signatures",
  );
  check(
    (await Promise.all(generic.map((store) => store.resolve(vectorScope)))).every(
      (value, index) => value === "synthetic-namespace-" + namespaces[index],
    ),
    "identity rotation leaves all eight generic namespaces unchanged",
  );

  stage = "recovery";
  await fixture("corrupt", vectorScope);
  check(
    (await refuses(() => vector.ensureIdentityKey(), "failed")) &&
      (await refuses(() => vector.sign(payload), "failed")),
    "a malformed stored key refuses ensure and signing without regeneration",
  );
  const recovery = await vector.probeRecoveryState();
  check(
    recovery.status === "recovery-required" &&
      recovery.reason === "failed" &&
      recovery.localDesktopUsable &&
      !recovery.remoteIdentityUsable,
    "malformed native identity reports recovery-only while local desktop stays usable",
  );
  const recovered = await vector.rotateIdentityKey();
  check(
    (await vector.probeRecoveryState()).status === "ready" &&
      (await vector.sign(payload)).fingerprint === recovered.fingerprint,
    "explicit rotation recovers the malformed namespace",
  );
  const unavailable = makeHostIdentitySigningService(
    join(dirname(helper), "absent", basename(helper)),
    { platform: "win32", storeScope: vectorScope },
  );
  const missing = await unavailable.probeRecoveryState();
  check(
    missing.status === "recovery-required" &&
      missing.reason === "unavailable" &&
      missing.localDesktopUsable &&
      !missing.remoteIdentityUsable,
    "a missing trusted helper remains recovery-only",
  );
} catch {
  console.log(JSON.stringify({ ownedIdentityFailure: true, stage, checks }));
  throw new Error("Owned Windows desktop identity acceptance failed.");
} finally {
  const genericCleanup = await Promise.allSettled(
    generic.map((store) => store.delete(vectorScope)),
  );
  let removed = true;
  for (const target of owned) {
    try {
      removed = (await fixture("remove", target.scope, target.family)) && removed;
    } catch {
      removed = false;
    }
  }
  let absent = true;
  for (const target of owned) {
    try {
      absent = (await fixture("absent", target.scope, target.family)) && absent;
    } catch {
      absent = false;
    }
  }
  const genericAbsence = await Promise.allSettled(generic.map((store) => store.has(vectorScope)));
  const cleaned =
    removed &&
    absent &&
    genericCleanup.every((value) => value.status === "fulfilled") &&
    genericAbsence.every((value) => value.status === "fulfilled" && !value.value);
  console.log(
    JSON.stringify({
      ownedIdentityCleanup: cleaned,
      fixturesJoined,
      rawHelpersJoined,
      identityTargets: owned.length,
      genericTargets: generic.length,
    }),
  );
  check(
    cleaned,
    "every owned native identity and generic target is absent and all fixture processes joined",
  );
}
console.log(
  JSON.stringify({
    platform: process.platform,
    node: process.versions.node,
    bun: process.versions.bun,
    electron: process.versions.electron,
    checks,
    hostAdmitted: false,
    workCodeEnabled: false,
    nonExportingProductionApi: true,
  }),
);
