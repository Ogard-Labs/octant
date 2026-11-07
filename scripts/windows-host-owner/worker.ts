import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { parentPort, workerData } from "node:worker_threads";
import { encodeOwnerReceipt } from "../../packages/host-runtime/src/ownerReceipt";
import { loadWindowsHostOwnerNative } from "../../packages/host-runtime/src/windowsHostOwner";

const input: unknown = workerData;
if (
  typeof input !== "object" ||
  input === null ||
  !("bindingPath" in input) ||
  typeof input.bindingPath !== "string" ||
  !("scope" in input) ||
  typeof input.scope !== "string"
)
  throw new Error("Missing owned worker fixture.");
if (loadWindowsHostOwnerNative(input.bindingPath) !== undefined)
  throw new Error("The production adapter admitted a worker.");
// The production adapter is main-thread-only. This disposable probe loads the
// private ABI directly solely to test environment teardown of native resources.
const native: unknown = createRequire(import.meta.url)(input.bindingPath);
if (
  typeof native !== "object" ||
  native === null ||
  !("prepare" in native) ||
  typeof native.prepare !== "function" ||
  !("claim" in native) ||
  typeof native.claim !== "function" ||
  !("poll" in native) ||
  typeof native.poll !== "function" ||
  !("close" in native) ||
  typeof native.close !== "function"
)
  throw new Error("Native worker ABI unavailable.");
const facts: unknown = native.prepare(input.scope);
if (
  typeof facts !== "object" ||
  facts === null ||
  !("status" in facts) ||
  facts.status !== "prepared" ||
  !("pid" in facts) ||
  typeof facts.pid !== "number" ||
  !("processStart" in facts) ||
  typeof facts.processStart !== "string" ||
  !("endpoint" in facts) ||
  typeof facts.endpoint !== "string" ||
  !("runtimeDirectory" in facts) ||
  typeof facts.runtimeDirectory !== "string"
)
  throw new Error("Native worker did not prepare.");
const nonce = randomBytes(32);
const receipt = Buffer.from(
  encodeOwnerReceipt({
    schemaVersion: 1,
    hostId: randomUUID(),
    instanceId: randomUUID(),
    endpoint: facts.endpoint,
    pid: facts.pid,
    processStart: facts.processStart,
    serverVersion: "fixture",
    wireVersion: "1",
    serviceMode: "foreground",
    nonceDigest: createHash("sha256").update(nonce.toString("base64url")).digest("hex"),
    createdAt: new Date().toISOString(),
  }),
);
let result: unknown;
try {
  result = native.claim(receipt, nonce);
} finally {
  nonce.fill(0);
  receipt.fill(0);
}
if (
  typeof result !== "object" ||
  result === null ||
  !("status" in result) ||
  result.status !== "owned"
)
  throw new Error("Native worker did not own its fixture.");
const poll = native.poll;
const close = native.close;
const timer = setInterval(() => poll(), 10);
setTimeout(() => {
  clearInterval(timer);
  close();
  parentPort?.close();
}, 10_000);
parentPort?.postMessage({
  ready: true,
  root: facts.runtimeDirectory,
  productionWorkerRefused: true,
});
