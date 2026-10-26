import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Schema } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SshDestination, SshExecutorPath } from "@octant/contracts/ssh-target";
import { SSH_EXECUTOR_PREAMBLE } from "@octant/contracts/ssh-executor-protocol";
import { SSH_CANARY_PROBES_BY_POSTURE } from "@octant/domain/ssh-target-admission-policy";
import { SshTargetConnectionService } from "./sshTargetConnectionService";
import { SshTargetRegistry } from "./sshTargetRegistry";

/**
 * The connection service against a stand-in for the OpenSSH client: a script
 * that answers a host-key probe by recording a key, and otherwise behaves as
 * the session would (a refused key, a missing executor, or an executor speaking
 * the framed protocol on its standard input and output). The loopback `sshd`
 * smoke test covers the real client and the real executor.
 */

const HOST_KEY = "AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl";
const BUILD = "0.9.0+test";
const destination = Schema.decodeUnknownSync(SshDestination)("build@devbox.example");
const executorPath = Schema.decodeUnknownSync(SshExecutorPath)("/opt/octant/bin/octant");

const FAKE_SSH = String.raw`
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.writeFileSync(process.env.FAKE_SSH_ARGS, JSON.stringify(args));
fs.writeFileSync(process.env.FAKE_SSH_ARGS + ".secret", String(process.env.OCTANT_DESKTOP_BRIDGE_SECRET));
const option = (name) => args.find((value) => value.startsWith(name + "="))?.slice(name.length + 1);
if (args.includes("-N")) {
  fs.writeFileSync(option("UserKnownHostsFile"), "devbox.example ssh-ed25519 " + process.env.FAKE_HOST_KEY + "\n");
  process.stderr.write("build@devbox.example: Permission denied (publickey).\n");
  process.exit(255);
}
const mode = process.env.FAKE_SSH_MODE;
if (mode === "host-key-changed") {
  process.stderr.write("@ WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED! @\nHost key verification failed.\n");
  process.exit(255);
}
if (mode === "executor-missing") {
  process.stderr.write("sh: 1: /opt/octant/bin/octant: not found\n");
  process.exit(127);
}
if (mode === "not-an-executor") {
  process.stdout.write("Usage: octant <command>\n");
  process.exit(1);
}
const frame = (value) => {
  const body = Buffer.from(JSON.stringify(value));
  const length = Buffer.alloc(4);
  length.writeUInt32BE(body.length);
  return Buffer.concat([length, body]);
};
process.stdout.write("Welcome to devbox\n");
process.stdout.write(${JSON.stringify(SSH_EXECUTOR_PREAMBLE)});
process.stdout.write(frame({ type: "hello", identity: JSON.parse(process.env.FAKE_IDENTITY) }));
let buffered = Buffer.alloc(0);
process.stdin.on("data", (chunk) => {
  buffered = Buffer.concat([buffered, chunk]);
  if (buffered.length < 4 || buffered.length < 4 + buffered.readUInt32BE(0)) return;
  const request = JSON.parse(buffered.subarray(4, 4 + buffered.readUInt32BE(0)).toString());
  fs.writeFileSync(process.env.FAKE_SSH_REQUEST, JSON.stringify(request));
  const facts = JSON.parse(process.env.FAKE_FACTS);
  process.stdout.write(frame({ type: "reply", id: request.id, reply: { kind: "attested", remoteUser: "build", facts } }));
});
process.stdin.on("end", () => process.exit(0));
`;

function passingFacts() {
  return {
    identity: { buildVersion: BUILD, protocolVersion: 1, installVerified: true },
    platform: { operatingSystem: "linux", architecture: "x64", uid: 1000 },
    backend: {
      kind: "bubblewrap",
      bwrapExecutable: true,
      unprivilegedUserNamespaces: true,
      binShExecutable: true,
    },
    canaries: (["plan", "approval-gated", "auto-accept-edits"] as const).map((posture) => ({
      posture,
      results: SSH_CANARY_PROBES_BY_POSTURE[posture].map((probe) => ({
        probe,
        outcome: "refused",
      })),
    })),
  };
}

let directory: string;
let registry: SshTargetRegistry;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "octant-ssh-service-"));
  registry = new SshTargetRegistry(join(directory, "data"));
  writeFileSync(join(directory, "ssh"), `#!${process.execPath}\n${FAKE_SSH}`, { mode: 0o700 });
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

function service(overrides: { readonly mode?: string; readonly identity?: object } = {}) {
  return new SshTargetConnectionService({
    registry,
    buildVersion: BUILD,
    sshExecutable: join(directory, "ssh"),
    environment: {
      PATH: process.env.PATH,
      FAKE_SSH_ARGS: join(directory, "args.json"),
      FAKE_SSH_REQUEST: join(directory, "request.json"),
      FAKE_HOST_KEY: HOST_KEY,
      FAKE_SSH_MODE: overrides.mode ?? "executor",
      FAKE_IDENTITY: JSON.stringify(overrides.identity ?? passingFacts().identity),
      FAKE_FACTS: JSON.stringify(passingFacts()),
      OCTANT_DESKTOP_BRIDGE_SECRET: "never-forwarded",
    },
  });
}

async function registered(connections: SshTargetConnectionService) {
  const probe = await connections.probeHostKey(destination);
  if (probe.status !== "ok") throw new Error("probe refused");
  const result = await connections.register({
    probeId: probe.value.probeId,
    fingerprint: probe.value.fingerprint,
    executorPath,
  });
  if (result.status !== "ok") throw new Error("registration refused");
  return result.value;
}

describe("SSH target connection service", () => {
  it("pins only the key the person confirmed, in an owner-only file of its own, and attests on registration", async () => {
    const connections = service();
    const probe = await connections.probeHostKey(destination);
    expect(probe).toMatchObject({
      status: "ok",
      value: { destination, hostKey: { algorithm: "ssh-ed25519", publicKey: HOST_KEY } },
    });
    if (probe.status !== "ok") return;
    expect(probe.value.fingerprint).toMatch(/^SHA256:[A-Za-z0-9+/]{43}$/u);

    const status = await connections.register({
      probeId: probe.value.probeId,
      fingerprint: probe.value.fingerprint,
      executorPath,
    });
    expect(status).toMatchObject({
      status: "ok",
      value: { connection: "connected", remoteUser: "build", platform: "linux" },
    });
    if (status.status !== "ok") return;
    expect(status.value.admission.map((entry) => entry.decision)).toEqual([
      { status: "admitted" },
      { status: "admitted" },
      { status: "admitted" },
    ]);
    const pin = registry.knownHostsFile(status.value.target.id);
    expect(readFileSync(pin, "utf8")).toBe(`* ssh-ed25519 ${HOST_KEY}\n`);
    expect(statSync(pin).mode & 0o777).toBe(0o600);

    const args: ReadonlyArray<string> = JSON.parse(
      readFileSync(join(directory, "args.json"), "utf8"),
    );
    expect(args.slice(args.indexOf("--"))).toEqual([
      "--",
      "build@devbox.example",
      "/opt/octant/bin/octant",
      "executor",
      "--stdio",
    ]);
    expect(args).toContain(`UserKnownHostsFile=${pin}`);
    expect(readFileSync(join(directory, "args.json.secret"), "utf8")).toBe("undefined");
    const request = JSON.parse(readFileSync(join(directory, "request.json"), "utf8"));
    expect(request.request.postures).toEqual([
      { posture: "plan", probes: SSH_CANARY_PROBES_BY_POSTURE.plan },
      { posture: "approval-gated", probes: SSH_CANARY_PROBES_BY_POSTURE["approval-gated"] },
      { posture: "auto-accept-edits", probes: SSH_CANARY_PROBES_BY_POSTURE["auto-accept-edits"] },
    ]);
    connections.close();
  });

  it("pins nothing for an unconfirmed fingerprint or a probe it no longer holds", async () => {
    const connections = service();
    const probe = await connections.probeHostKey(destination);
    if (probe.status !== "ok") throw new Error("probe refused");
    const other = `SHA256:${"A".repeat(43)}`;
    expect(
      await connections.register({
        probeId: probe.value.probeId,
        fingerprint: other,
        executorPath,
      }),
    ).toMatchObject({ status: "refused", reason: "fingerprint-not-confirmed" });
    // A probe is used once, so even the right fingerprint cannot reuse it.
    expect(
      await connections.register({
        probeId: probe.value.probeId,
        fingerprint: probe.value.fingerprint,
        executorPath,
      }),
    ).toMatchObject({ status: "refused", reason: "unknown-probe" });
    expect(registry.list()).toEqual([]);
  });

  it("names the refusal for a changed host key, a missing executor, and an executor of another build", async () => {
    const cases = [
      ["host-key-changed", {}, "host-key-changed"],
      ["executor-missing", {}, "executor-missing"],
      ["not-an-executor", {}, "executor-version-mismatch"],
      [
        "executor",
        { buildVersion: "0.8.9", protocolVersion: 1, installVerified: true },
        "executor-version-mismatch",
      ],
      [
        "executor",
        { buildVersion: BUILD, protocolVersion: 1, installVerified: false },
        "executor-version-mismatch",
      ],
    ] as const;
    for (const [mode, identity, reason] of cases) {
      const connections = service({ mode, ...(mode === "executor" ? { identity } : {}) });
      const status = await registered(connections);
      expect(status.connection).toBe(reason);
      for (const entry of status.admission) {
        expect(entry.decision).toEqual({ status: "refused", reason });
      }
      connections.close();
      rmSync(join(directory, "data"), { recursive: true, force: true });
    }
  });

  it("drops the attestation with its session, so a lost connection admits nothing", async () => {
    const connections = service();
    const status = await registered(connections);
    expect(
      connections.admit(status.target.id, {
        posture: "plan",
        permissionPersistence: "current-session",
        subject: { kind: "file-operation" },
      }),
    ).toEqual({ status: "admitted" });
    connections.close();
    expect(
      connections.admit(status.target.id, {
        posture: "plan",
        permissionPersistence: "current-session",
        subject: { kind: "file-operation" },
      }),
    ).toEqual({ status: "refused", reason: "target-unreachable" });
    expect(connections.remove(status.target.id)).toEqual({ status: "ok", value: null });
    expect(
      connections.admit(status.target.id, {
        posture: "plan",
        permissionPersistence: "current-session",
        subject: { kind: "file-operation" },
      }),
    ).toEqual({ status: "refused", reason: "target-removed" });
  });

  it("re-pins only with a key read from the target's own destination", async () => {
    const connections = service();
    const status = await registered(connections);
    const elsewhere = await connections.probeHostKey(
      Schema.decodeUnknownSync(SshDestination)("other.example"),
    );
    if (elsewhere.status !== "ok") throw new Error("probe refused");
    expect(
      await connections.repin({
        targetId: status.target.id,
        probeId: elsewhere.value.probeId,
        fingerprint: elsewhere.value.fingerprint,
      }),
    ).toMatchObject({ status: "refused", reason: "destination-mismatch" });
    connections.close();
  });
});
