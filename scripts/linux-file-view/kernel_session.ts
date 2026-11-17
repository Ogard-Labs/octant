/** Actual candidate-session lifecycle inside the owned networkless guest. */
import assert from "node:assert/strict";
import { decodeSandboxPolicySelection } from "@octant/contracts/sandbox-policy";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, statfs, writeFile } from "node:fs/promises";
import { setTimeout as pause } from "node:timers/promises";
import {
  prepareLinuxMediationSession,
  type LinuxMediationSession,
} from "../../apps/server/src/process/linuxMediationSession";
import { LINUX_MEDIATION_PRODUCTION_MAXIMUM_MS } from "../../apps/server/src/process/linuxMediationBroker";
import { secretGuardMediationPolicy } from "../../apps/server/src/process/secretGuard";
import {
  readOwnedProcessReceipts,
  readProcessIdentity,
} from "../../apps/server/src/process/nodeOwnedProcessReceipt";
import { spawn, spawnSync } from "node:child_process";

export async function measureProductionLaunch(root: string): Promise<{
  readonly privateRuntime: boolean;
  readonly configConsumed: boolean;
  readonly receiptsCleaned: boolean;
  readonly payloadExited: boolean;
}> {
  const productionRoot = `${root}/production`;
  const authority = `${productionRoot}/authority`;
  const project = `${productionRoot}/project`;
  const temporary = `${productionRoot}/temporary`;
  const readOnly = `${productionRoot}/read-only`;
  const denied = `${productionRoot}/denied`;
  for (const path of [productionRoot, authority, project, temporary, readOnly, denied])
    await mkdir(path, { recursive: true, mode: 0o700 });
  await writeFile(`${readOnly}/document`, "synthetic production read-only bytes", {
    mode: 0o600,
  });
  await writeFile(`${denied}/secret`, "synthetic production denied bytes", { mode: 0o600 });
  process.env.OCTANT_LINUX_MEDIATION_PREVIEW = "1";
  const { prepareLinuxMediatedLaunch } =
    await import("../../apps/server/src/process/linuxMediationProduction");
  const selection = decodeSandboxPolicySelection({
    policy: {
      schemaVersion: 1,
      revision: 1,
      filesystem: {
        readOnlyRoots: [readOnly],
        readWriteRoots: [],
        protectedPaths: [{ path: denied, mode: "deny" }],
      },
      network: "deny",
      credentials: "isolated",
      hostServices: "blocked",
    },
    context: {
      root: project,
      hostId: "owned-kernel-guest",
      projectId: "20000000-0000-4000-8000-000000000936",
      checkoutId: "owned-kernel-checkout",
      sessionId: "owned-kernel-session",
      provider: "native-production-proof",
    },
  });
  const receiptDirectory = `${authority}/linux-mediation-runtime/receipts`;
  const runtimeDirectory = `${authority}/linux-mediation-runtime`;
  let prepared: ReturnType<typeof prepareLinuxMediatedLaunch>;
  try {
    prepared = prepareLinuxMediatedLaunch(
      {
        executable: "/policy-workload",
        args: ["--session-exit", project, receiptDirectory],
        boundRoot: project,
        temporaryDirectory: temporary,
        networkEgress: "none",
        ownAccountAccess: "none",
      },
      selection,
      authority,
    );
  } catch (error) {
    const runtimeEntries = await readdir(runtimeDirectory).catch(() => []);
    const broker = runtimeEntries.find((name) => name.startsWith("broker-"));
    const probe =
      broker === undefined
        ? undefined
        : spawnSync(`${runtimeDirectory}/${broker}`, ["--check"], {
            timeout: 1_000,
            stdio: "ignore",
          });
    const filesystem = await statfs(productionRoot);
    console.log(
      JSON.stringify({
        status: "failed-production-preparation",
        runtimeAssets: {
          broker: broker !== undefined,
          launcher: runtimeEntries.some((name) => name.startsWith("launcher-")),
          worker: runtimeEntries.some((name) => name.startsWith("worker-")),
          supervisor: runtimeEntries.some((name) => name.startsWith("supervisor-")),
        },
        availableBytes: filesystem.bavail * filesystem.bsize,
        probeStatus: probe?.status,
        probeSignal: probe?.signal,
        probeError: (probe?.error as NodeJS.ErrnoException | undefined)?.code,
      }),
    );
    throw error;
  }
  assert.equal(prepared.command, process.execPath);
  assert.equal(prepared.args.length, 2);
  const supervisor = prepared.args[0] as string;
  const configuration = prepared.args[1] as string;
  const runtimeEntries = await readdir(runtimeDirectory);
  const launcher = runtimeEntries.find((name) => name.startsWith("launcher-"));
  const privateRuntime =
    (await stat(runtimeDirectory)).mode % 0o1000 === 0o700 &&
    (await stat(supervisor)).mode % 0o1000 === 0o400 &&
    launcher !== undefined &&
    (await stat(`${runtimeDirectory}/${launcher}`)).mode % 0o1000 === 0o500 &&
    runtimeEntries.some((name) => name.startsWith("broker-")) &&
    runtimeEntries.some((name) => name.startsWith("worker-")) &&
    runtimeEntries.some((name) => name.startsWith("supervisor-"));
  await writeFile(`${receiptDirectory}/private-marker`, "synthetic production receipt", {
    mode: 0o600,
  });
  const child = spawn(prepared.command, [...prepared.args], {
    stdio: "inherit",
    env: {
      HOME: "/tmp",
      PATH: "/usr/bin:/bin",
      LANG: "C",
      OCTANT_LINUX_MEDIATION_PREVIEW: "1",
      ...prepared.environment,
    },
  });
  const completed = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => resolve({ code, signal }));
    },
  );
  const configConsumed = await stat(configuration).then(
    () => false,
    (error: NodeJS.ErrnoException) => error.code === "ENOENT",
  );
  const receiptsCleaned =
    (await readdir(receiptDirectory)).filter((name) => name.endsWith(".json")).length === 0;
  const payloadExited =
    completed.code === 7 &&
    completed.signal === null &&
    (await stat(`${project}/session-stage`)).isFile();
  return { privateRuntime, configConsumed, receiptsCleaned, payloadExited };
}

// A runtime comparison, with the actual controller and worker at default JIT.
assert.equal(process.versions.bun, undefined);
assert.equal(process.env.NODE_OPTIONS, undefined);
assert.deepEqual(process.execArgv, []);

if (process.argv[2] === "--linux-mediation-worker") {
  const { runLinuxMediationWorker } =
    await import("../../apps/server/src/process/linuxMediationWorker");
  await runLinuxMediationWorker();
} else {
  assert(!Object.keys(process.env).some((name) => name.startsWith("BUN_JSC_")));
  process.env.OCTANT_TEST_SECRET = "synthetic host-only sentinel";
  process.env.OPENAI_API_KEY = "synthetic host-only key sentinel";
  const root = process.argv[3] ?? (await mkdtemp("/tmp/octant-session-"));
  const receipts = `${root}/receipts`;
  await mkdir(receipts, { recursive: true, mode: 0o700 });
  await mkdir(`${root}/tmp`, { recursive: true, mode: 0o700 });
  await writeFile(`${receipts}/private-marker`, "synthetic ownership marker");
  const signal = new AbortController();
  const deadline = setTimeout(() => signal.abort(), 35_000);
  let active: LinuxMediationSession | undefined;
  const prepare = (mode: string, maximumMs = 10_000, owner = signal.signal) =>
    prepareLinuxMediationSession({
      environment: { HOME: "/tmp", PATH: "/usr/bin:/bin", LANG: "C" },
      ownerId: "disposable-session",
      signal: owner,
      maximumMs,
      receiptDirectory: receipts,
      brokerExecutable: "/session-cases",
      brokerScript: "/session-cases.mjs",
      nativeExecutable: "/octant-mediation",
      launch: {
        executable: "/policy-workload",
        args: [mode, root, receipts],
        boundRoot: root,
        temporaryDirectory: `${root}/tmp`,
        networkEgress: "none",
        ownAccountAccess: "none",
      },
      policy: secretGuardMediationPolicy({
        platform: "linux",
        homeDirectory: `${root}/home`,
        ownAccountPaths: [],
      }),
      production: true,
    });
  const stage = async (mode: string, session: LinuxMediationSession, maximumMs: number) => {
    const until = performance.now() + 5_000;
    const completion: { value: Awaited<LinuxMediationSession["exited"]> | undefined } = {
      value: undefined,
    };
    void session.exited.then((value) => {
      completion.value = value;
    });
    for (;;) {
      const withinBound = performance.now() < until && !signal.signal.aborted;
      try {
        await stat(`${root}/session-stage`);
        if (withinBound) return;
      } catch {}
      const ended = completion.value;
      assert(
        withinBound && ended === undefined,
        JSON.stringify({
          case: mode,
          maximumMs,
          ...(ended === undefined
            ? { status: "pending" }
            : ended.result.status === "exited"
              ? { status: "exited", code: ended.result.code, cleanup: ended.cleanup }
              : {
                  status: "unavailable",
                  reason: ended.result.reason,
                  cleanup: ended.cleanup,
                }),
        }),
      );
      await pause(10);
    }
  };
  const start = async (mode: string, maximumMs?: number, owner?: AbortSignal) => {
    await rm(`${root}/session-stage`, { force: true });
    const prepared = await prepare(mode, maximumMs, owner);
    assert.equal(
      prepared.status,
      "ready",
      JSON.stringify({
        case: mode,
        maximumMs: maximumMs ?? 10_000,
        status: prepared.status,
        ...(prepared.status === "unavailable"
          ? { reason: prepared.reason, cleanup: prepared.cleanup }
          : {}),
      }),
    );
    if (prepared.status !== "ready") throw new Error("Session unavailable");
    active = prepared.session;
    // Real readiness must not fork/exec the command or create its marker.
    await assert.rejects(() => stat(`${root}/session-stage`), { code: "ENOENT" });
    assert.deepEqual(await active.launch(), { status: "released" });
    await stage(mode, active, maximumMs ?? 10_000);
    return active;
  };
  try {
    if (process.argv[2] === "--owner-child") {
      await start("--session-wait");
      // Deliberately omit close: actual OS owner death closes the private FD3.
      process.stdout.write("OWNER_READY\n");
      await new Promise<void>((resolve) =>
        signal.signal.addEventListener("abort", () => resolve(), { once: true }),
      );
    } else {
      const outcomes: string[] = [];
      const refused = await prepare("--session-wait", LINUX_MEDIATION_PRODUCTION_MAXIMUM_MS + 1);
      assert.equal(refused.status, "unavailable");
      assert.equal((await readdir(receipts)).filter((name) => name.endsWith(".json")).length, 0);
      outcomes.push("invalid-deadline-refuses-before-spawn");
      const prepared = await prepare("--session-wait");
      assert.equal(
        prepared.status,
        "ready",
        JSON.stringify({
          case: "close-before-launch",
          maximumMs: 10_000,
          status: prepared.status,
          ...(prepared.status === "unavailable"
            ? { reason: prepared.reason, cleanup: prepared.cleanup }
            : {}),
        }),
      );
      if (prepared.status !== "ready") throw new Error("Session unavailable");
      active = prepared.session;
      assert.deepEqual(await active.close(), {
        result: { status: "unavailable", reason: "cancelled" },
        cleanup: "confirmed",
      });
      await assert.rejects(() => stat(`${root}/session-stage`), { code: "ENOENT" });
      outcomes.push("close-before-launch-no-command");
      const early = await start("--session-exit");
      early.stdout.resume();
      early.stderr.resume();
      assert.deepEqual(await early.exited, {
        result: { status: "exited", code: 7 },
        cleanup: "confirmed",
      });
      outcomes.push("early-exit-real-code");
      const cancelled = new AbortController();
      const running = await start("--session-wait", 10_000, cancelled.signal);
      cancelled.abort();
      assert.deepEqual(await running.exited, {
        result: { status: "unavailable", reason: "cancelled" },
        cleanup: "confirmed",
      });
      outcomes.push("caller-cancellation-joins");
      const bounded = await start("--session-wait", 10_000);
      assert.deepEqual(await bounded.exited, {
        result: { status: "unavailable", reason: "deadline" },
        cleanup: "confirmed",
      });
      outcomes.push("deadline-joins");
      const duplex = await start("--session-echo");
      assert.equal(duplex.writeInput(Buffer.alloc(65_537)).status, "refused");
      const accepted = [];
      for (let count = 0; count < 4; count++) {
        const written = duplex.writeInput(Buffer.alloc(65_536, 97));
        assert.equal(written.status, "accepted");
        if (written.status === "accepted") accepted.push(written.drained);
      }
      let acceptedChunks = 4;
      const additional = duplex.writeInput(Buffer.alloc(65_536, 97));
      if (additional.status === "accepted") {
        accepted.push(additional.drained);
        acceptedChunks++;
      }
      // Exercise genuine pipe backpressure before attaching consumers; output
      // is counted, never accumulated as a transcript or sent to guest logs.
      await pause(100);
      let output = 0,
        errors = 0;
      duplex.stdout.on("data", (bytes: Buffer) => {
        output += bytes.length;
      });
      duplex.stderr.on("data", (bytes: Buffer) => {
        errors += bytes.length;
      });
      for (const drained of await Promise.all(accepted))
        assert.deepEqual(drained, { status: "drained" });
      for (let count = acceptedChunks; count < 16; count++) {
        const written = duplex.writeInput(Buffer.alloc(65_536, 97));
        assert.equal(written.status, "accepted");
        if (written.status === "accepted")
          assert.deepEqual(await written.drained, { status: "drained" });
      }
      duplex.endInput();
      assert.deepEqual(await duplex.exited, {
        result: { status: "exited", code: 0 },
        cleanup: "confirmed",
      });
      assert.equal(output, 1_048_576);
      assert.equal(errors, 1_048_576);
      outcomes.push("bounded-duplex-pressure-and-private-receipt-mask");
      await rm(`${root}/session-stage`, { force: true });
      const child = spawn("/session-cases", ["/session-cases.mjs", "--owner-child", root], {
        stdio: ["ignore", "pipe", "inherit"],
        env: { HOME: "/tmp", PATH: "/", LANG: "C" },
      });
      let ownerBytes = "";
      const childJoined = new Promise<void>((resolve) => child.once("close", () => resolve()));
      const ready = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Owned host did not prepare")), 8_000);
        child.stdout.on("data", (chunk: Buffer) => {
          ownerBytes += chunk.toString();
          if (ownerBytes.length > 128) {
            clearTimeout(timer);
            reject(new Error("Owner output overflow"));
          }
          if (ownerBytes === "OWNER_READY\n") {
            clearTimeout(timer);
            resolve();
          }
        });
        child.once("error", reject);
        child.once("exit", () => {
          if (ownerBytes !== "OWNER_READY\n") reject(new Error("Owner exited early"));
        });
      });
      try {
        await ready;
        const known = await readOwnedProcessReceipts({
          receiptDirectory: receipts,
          supervisor: "linux-mediation-session",
        });
        assert.equal(known.length, 3);
        const ended = new Promise<void>((resolve) => child.once("exit", () => resolve()));
        child.kill("SIGKILL");
        await ended;
        const until = performance.now() + 5_000;
        let orphanPid = 0;
        for (;;) {
          let live = 0;
          for (const { receipt } of known) {
            let text: string;
            try {
              text = await readFile(`/proc/${receipt.pid}/stat`, "utf8");
            } catch (error) {
              const code = (error as NodeJS.ErrnoException).code;
              if (code === "ENOENT" || code === "ESRCH") continue;
              throw error;
            }
            // A joined sibling can disappear between observations. Validate
            // the retained receipt after the snapshot before using its state.
            const identity = await readProcessIdentity(receipt.pid);
            if (identity === undefined) continue;
            assert.equal(identity, receipt.processIdentity);
            const fields = text
              .slice(text.lastIndexOf(")") + 1)
              .trim()
              .split(/\s+/);
            if (fields[0] === "Z" && fields[1] === "1") orphanPid = receipt.pid;
            else live++;
          }
          if (live === 0 && orphanPid > 0) break;
          assert(performance.now() < until, "Owner loss left a live owned process");
          await pause(10);
        }
        // PID1 must separately reap this exact owned orphan before reporting
        // joined cleanup. A zombie is terminated, never a joined receipt.
        console.log(`OCTANT_SESSION_ORPHAN ${orphanPid}`);
        outcomes.push("owner-loss-EOF-admission-and-command-stop");
      } finally {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        await childJoined;
      }
      const production = await measureProductionLaunch(root);
      assert.equal(production.privateRuntime, true);
      assert.equal(production.configConsumed, true);
      assert.equal(production.receiptsCleaned, true);
      assert.equal(production.payloadExited, true);
      outcomes.push("private-packaged-production-supervisor");
      console.log(
        JSON.stringify({
          status: "measured-owned-mediation-session",
          outcomes,
          productionReady: true,
          production,
          actualBubblewrapBuilder: true,
          defaultPayloadEnvironment: true,
          controllerJitDefaults: true,
          controllerRuntime: "node",
          controllerVersion: process.versions.node,
          orphanJoinPending: true,
        }),
      );
    }
  } finally {
    clearTimeout(deadline);
    signal.abort();
    if (process.argv[2] !== "--owner-child") {
      await active?.close();
      await rm(root, { recursive: true, force: true });
    }
  }
}
