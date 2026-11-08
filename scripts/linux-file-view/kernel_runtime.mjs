import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { watch } from "node:fs";
import { access, link, open, readFile, rename, stat, writeFile } from "node:fs/promises";
import { setTimeout as pause } from "node:timers/promises";

const [root] = process.argv.slice(2);
assert(root === "/tmp/octant-policy-broker");
const deadline = setTimeout(() => process.exit(70), 20_000);
const key = `${root}/home/.ssh/deployment`;
const original = `${root}/ordinary`;
const held = await open(key, "r");
assert.equal(await held.readFile("utf8"), "synthetic original-policy bytes");
const descriptor = await open(original, "r+");
try {
  await descriptor.sync();
  await link(original, `${root}/runtime-alias`);
  assert.equal((await stat(original)).ino, (await stat(`${root}/runtime-alias`)).ino);
  await writeFile(`${root}/runtime-alias`, "permitted after");
  await descriptor.sync();
  await rename(`${root}/runtime-alias`, `${root}/runtime-renamed`);
  assert.equal(await readFile(original, "utf8"), "permitted after");
  const bytes = Buffer.alloc(64);
  const read = await descriptor.read(bytes, 0, bytes.length, 0);
  assert.equal(bytes.subarray(0, read.bytesRead).toString(), "permitted after");
} finally {
  await descriptor.close();
}
if (process.versions.bun) {
  await Bun.write(`${root}/bun-native`, "permitted Bun native");
  assert.equal(await Bun.file(`${root}/bun-native`).text(), "permitted Bun native");
}
const child = spawnSync(process.execPath, ["-e", 'process.stdout.write("owned child")'], {
  encoding: "utf8",
  timeout: 5_000,
});
assert.equal(child.status, 0, child.stderr);
assert.equal(child.stdout, "owned child");

// The unconfined guest owner writes this name after watching starts. A write
// by this runtime or a reconstructed event cannot satisfy this observation.
await new Promise((resolve, reject) => {
  const maximum = setTimeout(() => {
    observer.close();
    reject(new Error("Outside native watch timed out"));
  }, 5_000);
  const observer = watch(root, (event, name) => {
    if (String(name) !== "runtime-outside") return;
    clearTimeout(maximum);
    observer.close();
    resolve();
  });
  observer.on("error", (error) => {
    clearTimeout(maximum);
    observer.close();
    reject(error);
  });
  writeFile(`${root}/watch-ready`, "ready").catch((error) => {
    clearTimeout(maximum);
    observer.close();
    reject(error);
  });
});
assert.equal(await readFile(`${root}/runtime-outside`, "utf8"), "outside permitted");
await writeFile(`${root}/stage`, "ready");
let companion = false;
for (let attempt = 0; attempt < 500; attempt += 1) {
  try {
    await access(`${key}.pub`);
    companion = true;
    break;
  } catch {
    await pause(10);
  }
}
assert(companion);
try {
  await assert.rejects(held.read(Buffer.alloc(64), 0, 64, 0), { code: "EACCES" });
  await assert.rejects(readFile(`${root}/alias`), { code: "EACCES" });
  await assert.rejects(writeFile(key, "must never replace protected data"), { code: "EACCES" });
  assert.equal(await readFile(`${key}.pub`, "utf8"), "synthetic public companion");
} finally {
  await held.close();
  clearTimeout(deadline);
}
console.log(
  JSON.stringify({
    status: "measured-kernel-runtime",
    runtime: process.versions.bun ? "bun" : "node",
    version: process.versions.bun ?? process.version,
    liveFiles: true,
    persistentWrite: true,
    heldDescriptor: true,
    hardlinkIdentity: true,
    nativeOutsideWatch: true,
    childJoined: true,
    lateHeldAndAliasRefused: true,
    protectedWriteRefused: true,
    publicContentReadable: true,
    productionReady: false,
  }),
);
