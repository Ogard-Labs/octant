import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { homedir, tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SSH_EXECUTOR_PROTOCOL_VERSION } from "@octant/contracts/ssh-executor-protocol";
import type { SshConfinedPosture } from "@octant/contracts/ssh-target";
import {
  SSH_CANARY_PROBES_BY_POSTURE,
  SSH_RUNTIME_CANARY_PROBES_BY_POSTURE,
} from "@octant/domain/ssh-target-admission-policy";
import {
  makeProcessConfinementLive,
  type ProcessConfinementPort,
} from "../process/seatbeltProfile";
import { attestExecutorConfinement } from "./executorAttestation";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

/** A listener standing in for the SSH server, which the network probe dials. */
async function sshServerStandIn(): Promise<number> {
  const server: Server = createServer((socket) => socket.destroy());
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  return typeof address === "object" && address !== null ? address.port : 0;
}

async function attestPlan(confinement?: ProcessConfinementPort) {
  return attest("plan", SSH_CANARY_PROBES_BY_POSTURE.plan, confinement);
}

async function attest(
  posture: SshConfinedPosture,
  probes: (typeof SSH_CANARY_PROBES_BY_POSTURE)[SshConfinedPosture],
  confinement?: ProcessConfinementPort,
) {
  const parent = realpathSync(mkdtempSync(join(tmpdir(), "octant-attest-")));
  cleanups.push(() => rmSync(parent, { recursive: true, force: true }));
  const session = join(parent, "session");
  mkdirSync(session, { mode: 0o700 });
  const reply = await attestExecutorConfinement(
    {
      identity: {
        buildVersion: "0.0.0",
        protocolVersion: SSH_EXECUTOR_PROTOCOL_VERSION,
        installVerified: true,
      },
      platform: process.platform,
      architecture: process.arch,
      uid: process.getuid?.() ?? 0,
      username: userInfo().username,
      homeDirectory: homedir(),
      runtimeExecutable: process.execPath,
      sessionDirectory: session,
      sessionParent: parent,
      sshServerAddress: { host: "127.0.0.1", port: await sshServerStandIn() },
      ...(confinement === undefined ? {} : { confinement }),
    },
    { kind: "attest", postures: [{ posture, probes }] },
  );
  return Object.fromEntries(
    reply.facts.canaries
      .flatMap((entry) => entry.results)
      .map((result) => [result.probe, result.outcome]),
  );
}

describe.skipIf(process.platform !== "darwin")("executor canaries on a macOS target", () => {
  it("reports every Plan probe refused by this Mac's Seatbelt", async () => {
    expect(await attestPlan()).toEqual({
      "write-inside-root": "refused",
      "exec-after-start": "refused",
      "fork-after-start": "refused",
      "open-network-socket": "refused",
      "read-sibling-folder": "refused",
      "read-other-session-runtime": "refused",
    });
  }, 60_000);

  it("reports every writing posture's probe and every runtime probe refused, the network ones through a loopback forwarder", async () => {
    for (const posture of ["plan", "approval-gated", "auto-accept-edits"] as const) {
      const probes = [
        ...SSH_CANARY_PROBES_BY_POSTURE[posture],
        ...SSH_RUNTIME_CANARY_PROBES_BY_POSTURE[posture],
      ];
      const outcomes = await attest(posture, probes);
      expect(Object.keys(outcomes).toSorted()).toEqual([...new Set(probes)].toSorted());
      expect(outcomes, posture).toEqual(
        Object.fromEntries(probes.map((probe) => [probe, "refused"])),
      );
    }
  }, 120_000);

  it("reports the escape when a writing posture's capsule reaches another loopback port than its forwarder's", async () => {
    const seatbelt = makeProcessConfinementLive({ platform: "darwin" });
    const open: ProcessConfinementPort = {
      prepare: (input) => seatbelt.prepare({ ...input, networkEgress: "allow" }),
    };
    expect(
      await attest(
        "approval-gated",
        ["connect-bypassing-forwarder", "runtime-connect-bypassing-proxy"],
        open,
      ),
    ).toEqual({
      "connect-bypassing-forwarder": "escaped",
      "runtime-connect-bypassing-proxy": "escaped",
    });
  }, 60_000);

  it("reports the escape when a Seatbelt capsule grants Plan what it forbids", async () => {
    const seatbelt = makeProcessConfinementLive({ platform: "darwin" });
    const loose: ProcessConfinementPort = {
      prepare: (input) =>
        seatbelt.prepare({
          ...input,
          writeBoundRoot: true,
          allowProcessExec: true,
          allowProcessFork: true,
          networkEgress: "allow",
        }),
    };
    expect(await attestPlan(loose)).toMatchObject({
      "write-inside-root": "escaped",
      "exec-after-start": "escaped",
      "fork-after-start": "escaped",
      "open-network-socket": "escaped",
    });
  }, 60_000);
});
