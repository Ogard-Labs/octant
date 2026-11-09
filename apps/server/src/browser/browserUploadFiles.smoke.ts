import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareBrowserUpload } from "./browserUploadFiles";

const root = await mkdtemp(join(tmpdir(), "octant-upload-runtime-"));
try {
  const contents = "bounded upload runtime fixture\n";
  await writeFile(join(root, "report.txt"), contents);
  const prepared = await prepareBrowserUpload({ workspaceRoot: root, files: ["report.txt"] });
  assert.equal(prepared.status, "prepared");
  if (prepared.status !== "prepared") throw new Error("The runtime refused its upload fixture.");
  try {
    const file = prepared.files[0];
    const path = prepared.paths[0];
    assert.ok(file !== undefined && path !== undefined);
    assert.equal(typeof file.device, "string");
    assert.equal(typeof file.inode, "string");
    assert.equal(file.linkCount, 1);
    assert.equal(file.sha256, createHash("sha256").update(contents).digest("hex"));
    await writeFile(join(root, "report.txt"), "changed source\n");
    assert.equal(await readFile(path, "utf8"), contents);
  } finally {
    await prepared.release();
  }
  console.log(
    JSON.stringify({
      check: "bounded-private-upload-copy",
      runtime: process.versions.bun === undefined ? "node" : "bun",
      platform: process.platform,
      result: "passed",
    }),
  );
} finally {
  await rm(root, { recursive: true, force: true });
}
