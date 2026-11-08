/** Actual candidate-session lifecycle inside the owned networkless guest. */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { setTimeout as pause } from "node:timers/promises";
import {
  prepareLinuxMediationSession,
  type LinuxMediationSession,
} from "../../apps/server/src/process/linuxMediationSession";
import { secretGuardMediationPolicy } from "../../apps/server/src/process/secretGuard";
import {
  readOwnedProcessReceipts,
  readProcessIdentity,
} from "../../apps/server/src/process/nodeOwnedProcessReceipt";
import { spawn } from "node:child_process";

if (process.argv[2] === "--linux-mediation-worker") {
  const { runLinuxMediationWorker } =
    await import("../../apps/server/src/process/linuxMediationWorker");
  await runLinuxMediationWorker();
} else {
  // Same existing diagnostic-only controller environment; guest commands get
  // none of these variables. This is not a controller-reliability fix.
  assert.equal(process.env.BUN_JSC_useFTLJIT, "0");
  delete process.env.BUN_JSC_useFTLJIT;
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
      const refused = await prepare("--session-wait", 180_001);
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
      assert.equal(duplex.writeInput(Buffer.alloc(65_536)).status, "refused");
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
      for (let count = 4; count < 16; count++) {
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
      const child = spawn("/session-cases", ["--owner-child", root], {
        stdio: ["ignore", "pipe", "inherit"],
        env: { HOME: "/tmp", PATH: "/", LANG: "C", BUN_JSC_useFTLJIT: "0" },
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
            const identity = await readProcessIdentity(receipt.pid);
            if (identity === undefined) continue;
            assert.equal(identity, receipt.processIdentity);
            const text = await readFile(`/proc/${receipt.pid}/stat`, "utf8");
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
      console.log(
        JSON.stringify({
          status: "measured-owned-mediation-session",
          outcomes,
          productionReady: false,
          actualBubblewrapBuilder: true,
          defaultPayloadEnvironment: true,
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
