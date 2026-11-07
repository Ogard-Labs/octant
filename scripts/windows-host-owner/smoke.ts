import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { rename, symlink } from "node:fs/promises";
import { createInterface } from "node:readline";
import {
  acquireWindowsHostRuntimeOwner,
  loadWindowsHostOwnerNative,
  type WindowsHostOwnerNative,
} from "../../packages/host-runtime/src/windowsHostOwner";

const bindingPath = process.argv[2] ?? "";
const selected = loadWindowsHostOwnerNative(bindingPath);
if (process.platform !== "win32" || selected === undefined)
  throw new Error("Native Windows binding did not load.");
const native: WindowsHostOwnerNative = selected;
const role = process.argv[3] ?? "parent";
const scope = process.argv[4] ?? randomUUID();
const hostId = "11111111-1111-4111-8111-111111111111";
const instanceId = randomUUID();
const options = {
  native,
  scope,
  hostId,
  instanceId,
  serverVersion: "fixture",
  wireVersion: "1",
  serviceMode: "foreground",
} as const;
const checks: string[] = [];
const fixtures = new Set<string>();
const children = new Set<ChildProcess>();
const lifetime = setTimeout(() => {
  for (const child of children) child.kill();
  process.exit(2);
}, 30_000);
function check(value: boolean, name: string) {
  if (!value) throw new Error(`Native owner check failed: ${name}`);
  checks.push(name);
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
function rootFor(scopeId: string): string {
  const facts = native.prepare(scopeId);
  if (!record(facts) || facts.status !== "prepared" || typeof facts.runtimeDirectory !== "string")
    throw new Error("Owned root preparation refused.");
  native.close();
  fixtures.add(facts.runtimeDirectory);
  return facts.runtimeDirectory;
}
async function boundedChild(scopeId: string): Promise<{ child: ChildProcess; root: string }> {
  const child = spawn(process.execPath, [process.argv[1] ?? "", bindingPath, "child", scopeId], {
    env: { ...process.env },
    stdio: ["pipe", "pipe", "inherit"],
    windowsHide: true,
  });
  children.add(child);
  const result = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("Owned child did not become ready."));
    }, 8_000);
    child.once("error", () => {
      clearTimeout(timer);
      reject(new Error("Owned child did not start."));
    });
    createInterface({ input: child.stdout }).on("line", (line) => {
      const parsed: unknown = JSON.parse(line);
      if (record(parsed) && parsed.ready === true && typeof parsed.root === "string") {
        clearTimeout(timer);
        resolve(parsed.root);
      }
    });
  });
  fixtures.add(result);
  return { child, root: result };
}
async function join(child: ChildProcess): Promise<void> {
  if (child.exitCode === null && child.signalCode === null) {
    child.kill();
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Owned child did not exit.")), 3_000);
      child.once("close", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
  children.delete(child);
}

if (role === "child") {
  const facts = native.prepare(scope);
  if (!record(facts) || typeof facts.runtimeDirectory !== "string")
    throw new Error("Child root missing.");
  native.close();
  const owner = await acquireWindowsHostRuntimeOwner(options);
  if (owner.kind !== "owner") throw new Error("Child did not own its endpoint.");
  console.log(JSON.stringify({ ready: true, root: facts.runtimeDirectory }));
  process.stdin.once("end", () => {
    void owner.release().then(() => process.exit(0));
  });
  process.stdin.resume();
} else {
  let held: Awaited<ReturnType<typeof acquireWindowsHostRuntimeOwner>> | undefined;
  try {
    const root = rootFor(scope);
    held = await acquireWindowsHostRuntimeOwner(options);
    check(held.kind === "owner", "owns one fixed private scope");
    if (held.kind !== "owner") throw new Error("Unexpected attachment.");
    check(
      held.receipt.pid === process.pid && held.receipt.processStart.startsWith("win32:"),
      "native current process birth matches runtime",
    );
    fixtures.add(root + ".moved");
    let renameRefused = false;
    try {
      await rename(root, root + ".moved");
    } catch {
      renameRefused = true;
    }
    check(renameRefused, "held canonical directory cannot be renamed");
    const bun: unknown = Reflect.get(globalThis, "Bun");
    if (record(bun) && typeof bun.gc === "function") bun.gc(true);
    else if (typeof globalThis.gc === "function") globalThis.gc();
    else throw new Error("A real GC operation is required for this fixture.");
    const pending = native.beginRequest(
      scope,
      Buffer.from(
        JSON.stringify({ version: 1, principal: "local", secret: "invalid-fixture", type: "stop" }),
      ),
    );
    check(
      record(pending) && pending.status === "pending" && typeof pending.id === "number",
      "private same-user client connects",
    );
    if (!record(pending) || typeof pending.id !== "number") throw new Error("Client not created.");
    let response: unknown;
    const deadline = performance.now() + 2500;
    while (performance.now() < deadline) {
      const state = native.pollRequest(pending.id);
      if (record(state) && state.status === "response" && state.bytes instanceof Uint8Array) {
        response = JSON.parse(Buffer.from(state.bytes).toString("utf8"));
        break;
      }
      if (!record(state) || state.status !== "pending") break;
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
    native.closeRequest(pending.id);
    check(
      record(response) && response.ok === false && response.error === "unauthorized",
      "forged control nonce has no authority",
    );
    await held.release();
    held = undefined;
    let refused = false;
    try {
      const again = await acquireWindowsHostRuntimeOwner(options);
      if (again.kind === "owner") held = again;
    } catch {
      refused = true;
    }
    check(refused, "closed endpoint never permits takeover of its live writer");

    const childScope = randomUUID();
    console.log(JSON.stringify({ fixtureScope: childScope }));
    const child = await boundedChild(childScope);
    const attached = await acquireWindowsHostRuntimeOwner({
      ...options,
      scope: childScope,
      instanceId: randomUUID(),
    });
    check(attached.kind === "attached", "authenticates an actual independent native writer");
    if (attached.kind !== "attached") {
      held = attached;
      throw new Error("Expected attachment.");
    }
    check(
      (await attached.request({ type: "status", principal: "local" }))?.ok === true,
      "existing host status protocol round-trips",
    );
    await join(child.child);
    held = await acquireWindowsHostRuntimeOwner({
      ...options,
      scope: childScope,
      instanceId: randomUUID(),
    });
    check(held.kind === "owner", "only verified dead writer permits recovery");
    if (held.kind === "owner") await held.release();
    held = undefined;

    const aliasScope = randomUUID();
    console.log(JSON.stringify({ fixtureScope: aliasScope }));
    const aliasRoot = rootFor(aliasScope);
    await rename(aliasRoot, aliasRoot + ".original");
    fixtures.delete(aliasRoot);
    fixtures.add(aliasRoot + ".original");
    await symlink(aliasRoot + ".original", aliasRoot, "junction");
    fixtures.add(aliasRoot);
    const alias = native.prepare(aliasScope);
    check(
      record(alias) && alias.status === "refused",
      "refuses a selected scope replaced by a reparse point",
    );
    native.close();
    console.log(
      JSON.stringify({
        runtime: process.versions,
        checks,
        hostAdmitted: false,
        workCodeEnabled: false,
      }),
    );
  } finally {
    if (held?.kind === "owner") await held.release();
    native.close();
    const settled = await Promise.allSettled([...children].map(join));
    check(
      settled.every((result) => result.status === "fulfilled"),
      "owned native children joined",
    );
    console.log(JSON.stringify({ fixtureRoots: [...fixtures].reverse() }));
    clearTimeout(lifetime);
    console.log(JSON.stringify({ nativeChildrenJoined: true, cleanupAfterProcessExit: true }));
  }
}
