import { setImmediate } from "node:timers/promises";
import { win32 } from "node:path";
import {
  loadWindowsHostProfileNative,
  resolveWindowsHostProfile,
} from "../../packages/host-runtime/src/windowsHostProfile";
import { createWindowsHostStartup } from "../../packages/host-runtime/src/windowsHostStartup";

const [binding, profile] = process.argv.slice(2);
if (
  process.platform !== "win32" ||
  !binding ||
  (profile !== "octant" && profile !== "nightly-test-data")
)
  throw Error("Supply the owned publication reader.");
const native = loadWindowsHostProfileNative(win32.resolve(binding));
if (native === undefined) throw Error("Native publication reader unavailable.");
const resolved = resolveWindowsHostProfile({ native, profile, env: {} });
if (resolved.status !== "ready") throw Error("Native publication profile unavailable.");
const startup = createWindowsHostStartup(native, resolved.paths);
if (startup === undefined) throw Error("Native publication ports unavailable.");
const lifetime = setTimeout(() => process.exit(2), 8000);
let ended = false;
process.stdin.on("end", () => {
  ended = true;
});
process.stdin.resume();
let reads = 0;
try {
  console.log("publication-reader-ready");
  while (!ended) {
    const receipt = await startup.readHostInfo();
    if (receipt?.hostId !== resolved.paths.profileId)
      throw Error("Published snapshot unavailable.");
    reads++;
    await setImmediate();
  }
  if (reads === 0) throw Error("No publication reads completed.");
  console.log(JSON.stringify({ publicationReads: reads }));
} finally {
  native.close();
  clearTimeout(lifetime);
}
