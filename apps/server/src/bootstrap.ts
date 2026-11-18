import { realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { resolve } from "node:path";
import { enableCompileCache } from "node:module";
import { enableCompileCacheBeneath, resolveHostRuntimePaths } from "@octant/host-runtime/paths";

// V8 spends a large share of host boot compiling the bundled server. A cache
// in the host's own data folder (owner-only, never the app bundle, which is
// signed and read-only) lets later launches reuse that work. This runs before
// main.ts decides whether to refuse the launch, so it has no side effect on a
// folder that is missing: the path is resolved without creating anything, and
// the first launch simply goes without a cache. Any failure leaves the host
// starting exactly as it would without one.
try {
  const { dataDirectory } = resolveHostRuntimePaths(
    {
      env: process.env,
      platform: process.platform,
      home: homedir(),
      temporaryDirectory: canonicalTemporaryDirectory(),
      uid: process.getuid?.() ?? 0,
    },
    { createDataDirectory: false },
  );
  enableCompileCacheBeneath(dataDirectory, enableCompileCache);
} catch {
  // Missing folder, unsupported platform or runtime: start without the cache.
}

await import("./main");

// Matches main.ts, so both resolve the same data folder.
function canonicalTemporaryDirectory(): string {
  try {
    return realpathSync(tmpdir());
  } catch {
    return resolve(tmpdir());
  }
}
