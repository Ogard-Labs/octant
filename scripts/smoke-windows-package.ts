import { execFile } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { desktopIdentity, resolveDesktopPackageFlavor } from "@octant/host-runtime";
import { resolveReleaseVersion } from "./package-desktop";
import { validateWindowsNativeArtifacts } from "./build-windows-native-artifacts";

if (process.platform !== "win32" || process.arch !== "x64") {
  throw new Error("Windows package acceptance requires a native Windows x64 runner.");
}
const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const version = resolveReleaseVersion(process.env);
const identity = desktopIdentity(resolveDesktopPackageFlavor(process.env, version));
const directory = join(root, "out", `${identity.productName}-win32-x64`);
const executable = join(directory, `${identity.productName}.exe`);
const archive = join(root, "out", `${identity.productName}-${version}-win32-x64.zip`);
await access(archive);
const header = await readFile(executable);
if (header.subarray(0, 2).toString() !== "MZ") throw new Error("Package executable is not PE.");
const payload = join(directory, "resources", "app");
const nativeDirectory = join(directory, "resources", "native");
await validateWindowsNativeArtifacts(nativeDirectory);
const licence = await readFile(join(payload, "LICENSE"), "utf8");
if (!licence.includes("MIT License") || !licence.includes("Ogard Labs")) {
  throw new Error("Windows package is missing the software licence.");
}
const probe = `
  const { createRequire } = require('node:module');
  const { resolve } = require('node:path');
  const load = createRequire(resolve('apps/server/package.json'));
  const Database = load('better-sqlite3');
  const database = new Database(':memory:');
  if (database.prepare('select 1 as value').get().value !== 1) process.exit(1);
  database.close();
  load('node-pty');
  const owner = require(${JSON.stringify(join(nativeDirectory, "octant-windows-host-owner.node"))});
  if (owner.apiVersion !== 1 || typeof owner.openProfile !== 'function' || typeof owner.prepare !== 'function') process.exit(1);
  console.log('octant-windows-package-native-imports-ok');
`;
await new Promise<void>((resolveProbe, reject) => {
  execFile(
    executable,
    ["--eval", probe],
    {
      cwd: payload,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      timeout: 30_000,
      maxBuffer: 64 * 1024,
    },
    (error, stdout) => {
      if (error || !stdout.includes("octant-windows-package-native-imports-ok")) {
        reject(new Error("Packaged Windows Electron could not load its native runtime."));
      } else resolveProbe();
    },
  );
});
console.log(
  "Windows portable archive and packaged native runtime verified; no UI or confinement claim.",
);
