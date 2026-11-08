/** Owned, networkless guest entry for the actual structured-policy broker. */
import { mkdir, readFile, rm, stat, writeFile, link } from "node:fs/promises";
import { setTimeout as pause } from "node:timers/promises";
import { runLinuxMediationBroker } from "../../apps/server/src/process/linuxMediationBroker";
import { buildBubblewrapLaunch } from "../../apps/server/src/process/linuxConfinement";
import { secretGuardMediationPolicy } from "../../apps/server/src/process/secretGuard";

const capsule = process.argv[2] === "--bubblewrap";
const root = "/tmp/octant-policy-broker";
const home = `${root}/home`;
const key = `${home}/.ssh/deployment`;
const owner = new AbortController();
const maximum = setTimeout(() => owner.abort(), 15_000);
let result = false;
let cleaned = false;
let ready = false;
let ended: Awaited<ReturnType<typeof runLinuxMediationBroker>> | undefined;
let running: ReturnType<typeof runLinuxMediationBroker> | undefined;
try {
  await mkdir(`${home}/.ssh`, { recursive: true, mode: 0o700 });
  await mkdir(`${root}/tmp`, { mode: 0o700 });
  // The actual production builder is unchanged. Populate every protected file
  // after it prepares startup covers, then change the companion during the run.
  // This measures the absent-file gap rather than an already-present mask.
  process.env.HOME = home;
  const launch = capsule
    ? buildBubblewrapLaunch({
        executable: "/policy-workload",
        args: [],
        boundRoot: root,
        temporaryDirectory: `${root}/tmp`,
        networkEgress: "none",
        ownAccountAccess: "none",
      })
    : { command: "/policy-workload", args: [] };
  await writeFile(key, "synthetic original-policy bytes", { mode: 0o600 });
  await link(key, `${root}/alias`);
  await writeFile(`${root}/ordinary`, "permitted before", { mode: 0o600 });
  await mkdir(`${root}/empty`, { mode: 0o700 });
  await mkdir(`${home}/.aws/sso/cache`, { recursive: true, mode: 0o700 });
  await writeFile(`${home}/.aws/sso/cache/token`, "synthetic guarded folder contents", {
    mode: 0o600,
  });
  await writeFile(`${home}/.ssh/id_independent`, "synthetic independently protected", {
    mode: 0o600,
  });
  await writeFile(`${home}/.ssh/id_independent.pub`, "public independent", { mode: 0o600 });
  running = runLinuxMediationBroker({
    nativeExecutable: "/octant-mediation",
    command: launch.command,
    args: launch.args,
    policy: secretGuardMediationPolicy({
      platform: "linux",
      homeDirectory: home,
      ownAccountPaths: [],
    }),
    signal: owner.signal,
  });
  const deadline = performance.now() + 10_000;
  while (!owner.signal.aborted && performance.now() < deadline) {
    try {
      ready = (await stat(`${root}/stage`)).isFile();
    } catch {
      // The enrolled synthetic command has not reached its allowed-read step.
    }
    if (ready) break;
    await pause(10);
  }
  if (ready) {
    await writeFile(`${root}/unrelated.pub`, "synthetic public companion", { mode: 0o600 });
    // Publish the companion last so the client sees both names atomically
    // with respect to its synchronization condition.
    await link(`${root}/unrelated.pub`, `${key}.pub`);
  } else owner.abort();
  ended = await running;
  result =
    ready &&
    ended.status === "exited" &&
    ended.code === 0 &&
    (await readFile(`${root}/ordinary`, "utf8")) === "permitted after";
} finally {
  clearTimeout(maximum);
  owner.abort();
  await running;
  await rm(root, { recursive: true, force: true });
  try {
    await stat(root);
  } catch (error) {
    cleaned =
      typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
  }
}
result = result && cleaned;
console.log(
  JSON.stringify({
    status: result ? "measured-original-policy-broker" : "failed",
    ended,
    productionReady: false,
    lateCompanion: ready,
    actualBubblewrapBuilder: capsule,
    ownedCommandJoined: ended?.status === "exited",
    cleaned,
  }),
);
// A normal exit flushes the small evidence record. No private metadata or
// protected bytes are ever sent to the command's stdout or to the journal.
process.exitCode = result ? 0 : 1;
