import { homedir } from "node:os";
import { join } from "node:path";
import { enableCompileCache } from "node:module";
import { resolveHostRuntimePaths } from "@octant/host-runtime/paths";

// V8 spends a large share of host boot compiling the bundled server. A cache
// in the host's own data folder (owner-only, never the app bundle, which is
// signed and read-only) lets later launches reuse that work. Any failure
// leaves the host starting exactly as it would without one.
try {
  const { dataDirectory } = resolveHostRuntimePaths({
    env: process.env,
    platform: process.platform,
    home: homedir(),
    temporaryDirectory: "/tmp",
    uid: process.getuid?.() ?? 0,
  });
  enableCompileCache(join(dataDirectory, "compile-cache"));
} catch {
  // Unsupported platform or runtime: start without the cache.
}

await import("./main");
