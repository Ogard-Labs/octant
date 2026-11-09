import assert from "node:assert/strict";
import { watch } from "node:fs";
import { link, open, readFile, rename, stat, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const [root, checker, expected] = process.argv.slice(2);
assert(root && checker && expected);
const original = join(root, "permitted");
const alias = join(root, "permitted-alias");
const moved = join(root, "renamed");
await writeFile(original, "native-permitted");
const descriptor = await open(original, "r+");
try {
  await descriptor.sync();
  assert.equal(await readFile(original, "utf8"), "native-permitted");
  await link(original, alias);
  assert.equal((await stat(original)).ino, (await stat(alias)).ino);
  await writeFile(alias, "persistent-update");
  await rename(alias, moved);
  assert.equal(await readFile(original, "utf8"), "persistent-update");
  assert.equal(await readFile(moved, "utf8"), "persistent-update");
  const bytes = Buffer.alloc(64);
  const held = await descriptor.read(bytes, 0, bytes.length, 0);
  assert.equal(bytes.subarray(0, held.bytesRead).toString(), "persistent-update");
} finally {
  await descriptor.close();
}
if (process.versions.bun) {
  await Bun.write(join(root, "bun-file"), "bun-native");
  assert.equal(await Bun.file(join(root, "bun-file")).text(), "bun-native");
}
const child = spawnSync(checker, ["check", expected], { encoding: "utf8", timeout: 3000 });
assert.equal(child.status, 0, child.stderr);
const inherited = JSON.parse(child.stdout);
assert.equal(inherited.refused, inherited.expected);
await new Promise((resolve, reject) => {
  const deadline = setTimeout(() => {
    observer.close();
    reject(new Error("Native watch timed out"));
  }, 3000);
  const observer = watch(root, (event, filename) => {
    if (String(filename) !== "outside-watch") return;
    clearTimeout(deadline);
    observer.close();
    resolve();
  });
  observer.on("error", reject);
  const writer = spawnSync("/bin/sh", ["-c", 'printf watch > "$1/outside-watch"', "sh", root], {
    timeout: 3000,
  });
  assert.equal(writer.status, 0);
});
console.log(
  JSON.stringify({
    runtime: process.versions.bun ? "bun" : "node",
    version: process.versions.bun ?? process.version,
    nativeReadWrite: true,
    heldDescriptor: true,
    hardlinkIdentity: true,
    persistentRename: true,
    nativeWatchFromChild: true,
    inheritedRefusals: inherited,
    productionReady: false,
  }),
);
