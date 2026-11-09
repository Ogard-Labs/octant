import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { makeWindowsCredentialStore } from "../packages/host-runtime/src/windowsCredentialStore";

if (process.platform !== "win32") throw new Error("Credential acceptance requires native Windows.");
const helperPath = resolve(process.argv[2] ?? "");
if (!helperPath.endsWith("octant-credential-helper.exe"))
  throw new Error("Supply the owned native helper build.");
const scope = randomUUID();
const ref = randomUUID();
const store = (
  storeScope = scope,
  serviceFamily: "octant" | "octant-nightly-test-data" = "octant",
) => makeWindowsCredentialStore({ helperPath, storeScope, serviceFamily });
const primary = store();
const otherScope = store(randomUUID());
const nightly = store(scope, "octant-nightly-test-data");
const checks: string[] = [];
let cleanupConfirmed = false;
function requireValue(value: boolean, check: string) {
  if (!value) throw new Error(`Native credential check failed: ${check}`);
  checks.push(check);
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

// Every target uses fresh opaque references. No enumerate, account lookup,
// actual provider key or pre-existing vault entry participates in this smoke.
try {
  requireValue(!(await primary.has(ref)), "owned target starts absent");
  requireValue(await refuses(() => primary.resolve(ref), "missing"), "absent read is missing");
  const first = "synthetic-native-λ-🔐-not-a-provider-key";
  await primary.set(ref, first);
  requireValue(
    (await primary.has(ref)) && (await primary.resolve(ref)) === first,
    "Unicode key round-trip",
  );
  requireValue(
    !(await otherScope.has(ref)) && !(await nightly.has(ref)),
    "store and flavor isolation",
  );
  await nightly.set(ref, "synthetic-nightly-only");
  await otherScope.set(ref, "synthetic-other-store-only");
  const boundary = "λ".repeat(1280);
  await primary.set(ref, boundary);
  requireValue((await primary.resolve(ref)) === boundary, "atomic replacement at 2560 bytes");
  requireValue(
    (await refuses(() => primary.set(ref, boundary + "x"), "invalid")) &&
      (await primary.resolve(ref)) === boundary,
    "overflow refused without replacing the key",
  );
  requireValue(
    await refuses(() => primary.set("../other-target", "synthetic"), "invalid"),
    "invalid reference refused",
  );
  requireValue(
    (await nightly.resolve(ref)) === "synthetic-nightly-only" &&
      (await otherScope.resolve(ref)) === "synthetic-other-store-only",
    "isolated replacements preserved",
  );

  const frame = Buffer.alloc(84);
  frame.write("OCCR");
  frame[4] = 1;
  frame[5] = 1;
  frame.write(scope, 7, "ascii");
  frame.write(ref, 43, "ascii");
  frame.writeUInt32LE(1, 79);
  frame[83] = 65;
  const nativeRefuses = async (input: Buffer) =>
    await new Promise<boolean>((resolveReply, reject) => {
      const child = spawn(helperPath, [], {
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
      }, 5_000);
      child.stdin.on("error", () => {});
      child.stdout.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > 9) {
          failed = true;
          child.kill();
        } else chunks.push(chunk);
      });
      child.once("error", () => {
        failed = true;
      });
      child.once("close", (code) => {
        clearTimeout(timer);
        const output = Buffer.concat(chunks);
        const refused =
          code === 0 &&
          output.length === 9 &&
          output.toString("ascii", 0, 4) === "OCCR" &&
          output[4] === 2 &&
          output.readUInt32LE(5) === 0;
        for (const chunk of chunks) chunk.fill(0);
        output.fill(0);
        if (failed) reject(new Error("Owned protocol probe failed to exit cleanly."));
        else resolveReply(refused);
      });
      child.stdin.end(input);
    });
  const invalidReference = Buffer.from(frame);
  invalidReference[43] = 46;
  const extra = Buffer.concat([frame, Buffer.from([0])]);
  const oversized = Buffer.from(frame.subarray(0, 83));
  oversized.writeUInt32LE(2561, 79);
  requireValue(
    (await nativeRefuses(invalidReference)) &&
      (await nativeRefuses(extra)) &&
      (await nativeRefuses(oversized)),
    "native malformed frames refused before mutation",
  );
  requireValue(
    (await primary.resolve(ref)) === boundary,
    "malformed requests preserved existing key",
  );
  await primary.delete(ref);
  requireValue(!(await primary.has(ref)), "explicit delete removes only owned target");
} finally {
  // No target is retained even after a failed scenario. A cleanup error fails CI.
  const cleanup = await Promise.allSettled([
    primary.delete(ref),
    nightly.delete(ref),
    otherScope.delete(ref),
  ]);
  cleanupConfirmed = cleanup.every((result) => result.status === "fulfilled");
  console.log(JSON.stringify({ ownedCredentialCleanupConfirmed: cleanupConfirmed }));
}
requireValue(
  cleanupConfirmed &&
    !(await primary.has(ref)) &&
    !(await nightly.has(ref)) &&
    !(await otherScope.has(ref)),
  "all three owned targets confirmed absent",
);
console.log(
  JSON.stringify({
    platform: process.platform,
    checks,
    cleanup: true,
    hostAdmitted: false,
    workCodeEnabled: false,
  }),
);
