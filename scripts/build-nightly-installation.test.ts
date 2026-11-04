import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile, symlink } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect } from "vitest";

describe("the bounded native Nightly transaction", () => {
  it.skipIf(process.platform !== "darwin")(
    "discards real ditto metadata, refuses combined symlink escapes, preserves existing targets and reports incomplete drain",
    async () => {
      const root = await mkdtemp(resolve(tmpdir(), "octant-installation-check-"));
      const run = (command: string, args: ReadonlyArray<string>, timeout = 20_000) => {
        const result = spawnSync(command, args, { encoding: "utf8", timeout });
        expect(result.error).toBeUndefined();
        expect(result.status, result.stderr).toBe(0);
        return result;
      };
      try {
        const app = resolve(root, "source", "Octant Nightly.app");
        await mkdir(resolve(app, "Contents", "Resources"), { recursive: true });
        const file = resolve(app, "Contents", "Resources", "fixture.txt");
        await writeFile(file, "synthetic archive data");
        run("/usr/bin/xattr", ["-w", "com.octant.fixture", "synthetic", file]);
        const valid = resolve(root, "valid.zip"),
          invalid = resolve(root, "invalid.zip");
        run("/usr/bin/ditto", ["-c", "-k", "--keepParent", "--sequesterRsrc", app, valid]);
        await symlink(".", resolve(app, "b"));
        await symlink("b/../outside", resolve(app, "a"));
        run("/usr/bin/ditto", ["-c", "-k", "--keepParent", "--sequesterRsrc", app, invalid]);
        const destination = resolve(root, "destination");
        await mkdir(destination);
        const executable = resolve(root, "checks");
        run("xcrun", [
          "clang++",
          "-x",
          "objective-c++",
          "-std=c++20",
          "-fblocks",
          "-Wall",
          "-Wextra",
          "-Werror",
          "-Wno-unused-function",
          "-Wno-unused-const-variable",
          "-Wno-deprecated-declarations",
          resolve(import.meta.dirname, "../apps/desktop/src/native/nightlyInstallation.test.cpp"),
          "-framework",
          "Security",
          "-framework",
          "CoreFoundation",
          "-framework",
          "AppKit",
          "-framework",
          "CoreServices",
          "-larchive",
          "-o",
          executable,
        ]);
        const result = run(executable, [destination, valid, invalid], 10_000);
        expect(result.stdout).toContain(
          "bounded archive, symlink, exclusive publish and actual drain checks passed",
        );
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
    30_000,
  );
});

const desktopManifest = JSON.parse(
  readFileSync(resolve(import.meta.dirname, "../apps/desktop/package.json"), "utf8"),
) as { readonly devDependencies: { readonly electron: string } };
const cachedHeaders = resolve(
  homedir(),
  ".electron-gyp",
  desktopManifest.devDependencies.electron,
  "include/node",
);

describe("native installer process admission", () => {
  it.skipIf(process.platform !== "darwin" || !existsSync(resolve(cachedHeaders, "node_api.h")))(
    "refuses unsigned runtime and Worker mutations without closing the main owner, then drains accepted callbacks",
    async () => {
      const root = await mkdtemp(resolve(tmpdir(), "octant-installation-admission-"));
      try {
        const binding = resolve(root, "installation.node");
        const build = spawnSync(
          "xcrun",
          [
            "clang++",
            "-x",
            "objective-c++",
            "-std=c++20",
            "-fblocks",
            "-dynamiclib",
            "-undefined",
            "dynamic_lookup",
            "-DNAPI_VERSION=8",
            "-DNODE_GYP_MODULE_NAME=octant_nightly_installation",
            "-I",
            cachedHeaders,
            "-Wall",
            "-Wextra",
            "-Werror",
            "-Wno-deprecated-declarations",
            resolve(import.meta.dirname, "../apps/desktop/src/native/nightlyInstallation.mm"),
            "-framework",
            "Security",
            "-framework",
            "CoreFoundation",
            "-framework",
            "AppKit",
            "-framework",
            "CoreServices",
            "-larchive",
            "-o",
            binding,
          ],
          { encoding: "utf8", timeout: 20_000 },
        );
        expect(build.error).toBeUndefined();
        expect(build.status, build.stderr).toBe(0);
        const runner = resolve(root, "admission.cjs");
        await writeFile(
          runner,
          `const { Worker } = require('node:worker_threads');
const assert = require('node:assert/strict');
const native = require(process.argv[2]);
const guard = setTimeout(() => process.exit(2), 9000);
(async () => {
 const worker = new Worker(\`const {parentPort,workerData}=require('node:worker_threads'); const n=require(workerData); (async()=>parentPort.postMessage([await n.close(),await n.cancel()]))();\`, {eval:true,workerData:process.argv[2]});
 const exited = new Promise((resolve,reject)=>{worker.once('exit',resolve);worker.once('error',reject)});
 const receipts = await new Promise((resolve,reject)=>{worker.once('message',resolve);worker.once('error',reject)});
 assert(receipts.every(r=>r.kind==='failed' && r.reason==='native-unavailable'));
 await exited;
 const admission = await native.inspect();
 assert.equal(admission.kind,'refused');
 assert(['unsigned-build','invalid-peer'].includes(admission.reason));
 assert.deepEqual(await native.close('unexpected'), {kind:'refused',reason:'invalid-artifact'});
 assert(['unsigned-build','invalid-peer'].includes((await native.inspect()).reason));
 if (process.argv[3] === 'cancel-close') {
  const cancellation = native.cancel();
  const closing = native.close();
  assert.deepEqual(await closing, {kind:'failed',reason:'native-unavailable'});
  assert.equal((await cancellation).kind, 'cancelled');
  assert.deepEqual(await native.inspect(), {kind:'refused',reason:'closed'});
  assert.deepEqual(await native.commitInstall(), {kind:'refused',reason:'closed'});
  clearTimeout(guard); console.log('close during pending cancellation remains terminal'); return;
 }
 const pending = Array.from({length:8},()=>native.inspect());
 let settled=0; pending.forEach(p=>p.then(()=>settled++));
 const closed=await native.close();
 assert.equal(closed.kind,'closed'); assert.equal(settled,8);
 assert.deepEqual(await native.commitInstall(),{kind:'refused',reason:'closed'});
 assert.equal((await native.cancel()).kind,'cancelled');
 assert.deepEqual(await native.inspect(),{kind:'refused',reason:'closed'});
 clearTimeout(guard); console.log('unsigned and Worker refusal, terminal ownership and actual callback drain passed');
})().catch(error=>{clearTimeout(guard);console.error(error.message);process.exitCode=1});
`,
        );
        const result = spawnSync(process.execPath, [runner, binding], {
          encoding: "utf8",
          timeout: 12_000,
        });
        expect(result.error).toBeUndefined();
        expect(result.status, result.stderr).toBe(0);
        expect(result.stdout).toContain(
          "unsigned and Worker refusal, terminal ownership and actual callback drain passed",
        );
        const raced = spawnSync(process.execPath, [runner, binding, "cancel-close"], {
          encoding: "utf8",
          timeout: 12_000,
        });
        expect(raced.error).toBeUndefined();
        expect(raced.status, raced.stderr).toBe(0);
        expect(raced.stdout).toContain("close during pending cancellation remains terminal");
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
    30_000,
  );
});
