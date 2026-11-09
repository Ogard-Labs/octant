/** Owned, networkless guest entry for the actual structured-policy broker. */
import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
  link,
} from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { setTimeout as pause } from "node:timers/promises";
import { runLinuxMediationBroker } from "../../apps/server/src/process/linuxMediationBroker";
import { buildBubblewrapLaunch } from "../../apps/server/src/process/linuxConfinement";
import { secretGuardMediationPolicy } from "../../apps/server/src/process/secretGuard";
import {
  linuxMediationObjectKey,
  readLinuxMediationPolicy,
} from "../../apps/server/src/process/linuxMediationPolicy";

if (process.argv[2] === "--metadata-control") {
  const control = await mkdtemp("/tmp/octant-classifier-control-");
  const started = performance.now();
  const snapshots = 256;
  let cleaned = false;
  try {
    assert(!Object.keys(process.env).some((name) => name.startsWith("BUN_JSC_")));
    await mkdir(`${control}/.ssh`, { mode: 0o700 });
    await writeFile(`${control}/.ssh/deployment`, "synthetic control", { mode: 0o600 });
    await writeFile(`${control}/.ssh/deployment.pub`, "synthetic public control");
    await symlink("synthetic missing target", `${control}/.ssh/id_control`);
    const secret = linuxMediationObjectKey(
      await stat(`${control}/.ssh/deployment`, { bigint: true }),
    );
    const publicKey = linuxMediationObjectKey(
      await stat(`${control}/.ssh/deployment.pub`, { bigint: true }),
    );
    const policy = secretGuardMediationPolicy({
      platform: "linux",
      homeDirectory: control,
      ownAccountPaths: [],
    });
    for (let count = 0; count < snapshots; count++) {
      assert(performance.now() - started < 10_000, "Classifier control exceeded its finite bound");
      const snapshot = await readLinuxMediationPolicy(policy, async () => ({
        epoch: 1n,
        activeMutations: 0,
      }));
      assert.equal(snapshot.status, "ready");
      if (snapshot.status === "ready") {
        assert(snapshot.protectedObjects.has(secret));
        assert(!snapshot.protectedObjects.has(publicKey));
      }
    }
  } finally {
    await rm(control, { recursive: true, force: true });
    try {
      await stat(control);
    } catch (error) {
      cleaned =
        typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
    }
  }
  assert(cleaned);
  console.log(
    JSON.stringify({
      status: "measured-unconfined-classifier",
      snapshots,
      jitDefaults: true,
      enrolled: false,
      cleaned,
    }),
  );
  process.exit(0);
}

// Only this disposable controller disables the tier that aborted before the
// Node case. Bun reads the debugging-only option at startup; remove it before
// any relay/command spawn so the measured runtimes retain their normal JITs.
assert.equal(process.env.BUN_JSC_useFTLJIT, "0");
delete process.env.BUN_JSC_useFTLJIT;

const runtime =
  process.argv[2] === "--runtime-bun"
    ? "bun"
    : process.argv[2] === "--runtime-node"
      ? "node"
      : undefined;
const capsule = process.argv[2] === "--bubblewrap" || runtime !== undefined;
const fileattr = process.argv[2] === "--fileattr";
const overlayCopyup = process.argv[2] === "--overlay-copyup";
const workload = overlayCopyup
  ? "/overlayfs-workload"
  : fileattr
    ? "/fileattr-workload"
    : "/policy-workload";
const root = fileattr ? "/octant-fileattr" : "/tmp/octant-policy-broker";
const home = `${root}/home`;
const key = `${home}/.ssh/deployment`;
const stage = overlayCopyup ? `${root}/overlay-copyup-stage` : `${root}/stage`;
const owner = new AbortController();
const maximum = setTimeout(() => owner.abort(), runtime === undefined ? 15_000 : 25_000);
let result = false;
let cleaned = false;
let ready = false;
let metadataVerified = false;
let overlayMounted = false;
let overlayCopyupBeforeTransition = false;
let overlayWriteRefused = false;
let overlayVerified = false;
let overlayUnmounted = false;
let overlayReport: Record<string, unknown> | undefined;
let ended: Awaited<ReturnType<typeof runLinuxMediationBroker>> | undefined;
let running: ReturnType<typeof runLinuxMediationBroker> | undefined;
try {
  if (overlayCopyup) {
    const setup = spawnSync("/overlayfs-fixture", ["mount"], {
      encoding: "utf8",
      timeout: 4_000,
    });
    overlayMounted =
      setup.status === 0 &&
      setup.stdout
        .trim()
        .split("\n")
        .some((line) => {
          try {
            return JSON.parse(line).overlayFs === true;
          } catch {
            return false;
          }
        });
    assert(overlayMounted, "The private disposable OverlayFS setup did not mount.");
  } else {
    await mkdir(`${home}/.ssh`, { recursive: true, mode: 0o700 });
  }
  await mkdir(`${root}/tmp`, { mode: 0o700 });
  if (runtime !== undefined)
    await writeFile(`${root}/runtime.mjs`, await readFile("/kernel-runtime.mjs"));
  // The actual production builder is unchanged. Populate every protected file
  // after it prepares startup covers, then change the companion during the run.
  // This measures the absent-file gap rather than an already-present mask.
  process.env.HOME = home;
  const launch =
    capsule || fileattr
      ? buildBubblewrapLaunch({
          executable: runtime === undefined ? workload : `/usr/bin/${runtime}`,
          args: runtime === undefined ? [] : [`${root}/runtime.mjs`, root],
          boundRoot: root,
          temporaryDirectory: `${root}/tmp`,
          networkEgress: "none",
          ownAccountAccess: "none",
        })
      : { command: workload, args: [] };
  if (!overlayCopyup) {
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
    await symlink("synthetic protected link text", `${home}/.ssh/id_link`);
    await symlink("deployment.pub", `${home}/.ssh/link.pub`);
  }
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
  const deadline = performance.now() + (runtime === undefined ? 10_000 : 20_000);
  let outsidePublished = false;
  while (!owner.signal.aborted && performance.now() < deadline) {
    try {
      if (
        runtime !== undefined &&
        !outsidePublished &&
        (await stat(`${root}/watch-ready`)).isFile()
      ) {
        // Publish completed content atomically. An inotify create event alone
        // does not promise the writer has finished writing the new file.
        await writeFile(`${root}/runtime-outside-pending`, "outside permitted");
        await rename(`${root}/runtime-outside-pending`, `${root}/runtime-outside`);
        outsidePublished = true;
      }
      ready = (await stat(stage)).isFile();
    } catch {
      // The enrolled synthetic command has not reached its allowed-read step.
    }
    if (ready) break;
    await pause(10);
  }
  if (ready) {
    if (overlayCopyup) {
      const before = spawnSync("/overlayfs-fixture", ["check-copyup"], {
        encoding: "utf8",
        timeout: 4_000,
      });
      overlayCopyupBeforeTransition =
        before.status === 0 &&
        before.stdout
          .trim()
          .split("\n")
          .some((line) => {
            try {
              return JSON.parse(line).copyUpBeforeTransition === true;
            } catch {
              return false;
            }
          });
      if (overlayCopyupBeforeTransition) {
        await writeFile(`${key}.pub`, "synthetic public companion", { mode: 0o600 });
      } else {
        owner.abort();
      }
    } else {
      await writeFile(`${root}/unrelated.pub`, "synthetic public companion", { mode: 0o600 });
      // Publish the companion last so the client sees both names atomically
      // with respect to its synchronization condition.
      await link(`${root}/unrelated.pub`, `${key}.pub`);
    }
  } else owner.abort();
  ended = await running;
  if (overlayCopyup) {
    const inspected = spawnSync("/overlayfs-fixture", ["inspect-unmount"], {
      encoding: "utf8",
      timeout: 4_000,
    });
    for (const line of inspected.stdout.trim().split("\n")) {
      try {
        const report = JSON.parse(line) as Record<string, unknown>;
        if (report.status === "overlayfs-disposable-repro") overlayReport = report;
      } catch {
        // Only the fixture's fixed JSON receipt is retained.
      }
    }
    overlayVerified =
      inspected.status === 0 &&
      overlayReport?.upperCopyAfterDeniedWrite === true &&
      overlayReport.contentUnchanged === true &&
      overlayReport.distinctUpperObject === true &&
      overlayReport.unmounted === true &&
      overlayReport.productionReady === false;
    overlayUnmounted = overlayReport?.unmounted === true;
    overlayWriteRefused = ended.status === "exited" && ended.code === 0;
    result =
      ready &&
      overlayCopyupBeforeTransition &&
      overlayWriteRefused &&
      overlayVerified;
  } else {
    metadataVerified =
      runtime !== undefined ||
      spawnSync(workload, [fileattr ? "--verify-fileattr" : "--verify-metadata"], {
        stdio: "inherit",
        timeout: 2_000,
      }).status === 0;
    result =
      ready &&
      ended.status === "exited" &&
      ended.code === 0 &&
      (await readFile(`${root}/ordinary`, "utf8")) === "permitted after" &&
      (await readFile(key, "utf8")) === "synthetic original-policy bytes" &&
      metadataVerified;
  }
} finally {
  clearTimeout(maximum);
  owner.abort();
  await running;
  if (overlayCopyup && !overlayUnmounted) {
    const cleanup = spawnSync("/overlayfs-fixture", ["unmount"], {
      encoding: "utf8",
      timeout: 4_000,
    });
    overlayUnmounted =
      cleanup.status === 0 &&
      cleanup.stdout
        .trim()
        .split("\n")
        .some((line) => {
          try {
            return JSON.parse(line).unmounted === true;
          } catch {
            return false;
          }
        });
  }
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
    status: overlayCopyup
      ? result
        ? "measured-overlayfs-copy-up"
        : "failed-overlayfs-copy-up"
      : fileattr
        ? result
          ? "measured-fileattr-broker"
          : "failed-fileattr-broker"
        : result
          ? "measured-original-policy-broker"
          : "failed",
    ended,
    productionReady: false,
    lateCompanion: ready,
    actualBubblewrapBuilder: capsule || fileattr,
    runtime: runtime ?? "native",
    ...(runtime === undefined && !overlayCopyup ? { metadataUnchanged: metadataVerified } : {}),
    ...(overlayCopyup
      ? {
          overlayCopyupBeforeTransition,
          overlayWriteRefused,
          overlayVerified,
          overlayUnmounted,
          overlayReport,
        }
      : {}),
    ownedCommandJoined: ended?.status === "exited",
    cleaned,
  }),
);
// A normal exit flushes the small evidence record. No private metadata or
// protected bytes are ever sent to the command's stdout or to the journal.
process.exitCode = result ? 0 : 1;
