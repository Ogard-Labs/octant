import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Schema } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SshDestination, SshExecutorPath, SshRemotePath } from "@octant/contracts/ssh-target";
import { SSH_EXECUTOR_PREAMBLE } from "@octant/contracts/ssh-executor-protocol";
import { SSH_CANARY_PROBES_BY_POSTURE } from "@octant/domain/ssh-target-admission-policy";
import { bindSshRemoteHarness } from "./sshRemoteHarness";
import { SshRemoteProjectService } from "./sshRemoteProjectService";
import { SshTargetConnectionService } from "./sshTargetConnectionService";
import type { SshTargetStore } from "./sshTargetStore";
import { openSshTargetTestStore } from "./sshTargetStore.test-support";

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
const option = (name) => JSON.parse(args.find((value) => value.startsWith(name + "="))?.slice(name.length + 1));
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
if (mode === "exits-after-introduction") process.exit(1);
const answer = (request) => {
  switch (request.kind) {
    case "attest":
      return { kind: "attested", remoteUser: "build", facts: JSON.parse(process.env.FAKE_FACTS) };
    case "resolve-root":
      return { kind: "root-resolved", root: "/srv/app" };
    case "list-directory":
      return request.root === "/srv/app"
        ? { kind: "directory-listed", listing: { entries: [{ kind: "file", path: "README.md", byteLength: 6 }], truncated: false } }
        : { kind: "refused", reason: "root-moved" };
    case "git-status":
      return { kind: "git-status", status: { head: { kind: "unborn", name: "main" }, entries: [{ path: "README.md", index: "?", worktree: "?" }], truncated: false } };
    case "harness-file":
      return { kind: "harness-file", result: { kind: "written", path: request.operation.arguments.path, bytes: 2, created: true } };
    case "run-command":
      return { kind: "command-ran", termination: "exited", exitCode: 0, stdout: Buffer.from("ran on " + request.root).toString("base64"), stderr: "" };
    default:
      return { kind: "refused", reason: "read-failed" };
  }
};
let buffered = Buffer.alloc(0);
process.stdin.on("data", (chunk) => {
  buffered = Buffer.concat([buffered, chunk]);
  while (buffered.length >= 4 && buffered.length >= 4 + buffered.readUInt32BE(0)) {
    const length = buffered.readUInt32BE(0);
    const request = JSON.parse(buffered.subarray(4, 4 + length).toString());
    buffered = buffered.subarray(4 + length);
    if (request.request.kind === "attest") fs.writeFileSync(process.env.FAKE_SSH_REQUEST, JSON.stringify(request));
    fs.appendFileSync(process.env.FAKE_SSH_REQUEST + ".log", request.request.kind + "\n");
    const outOfTurn = mode === "answers-out-of-turn" && request.request.kind !== "attest";
    process.stdout.write(frame({ type: "reply", id: request.id + (outOfTurn ? 1 : 0), reply: answer(request.request) }));
  }
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
let registry: SshTargetStore;
let closeStore: () => void;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "octant-ssh-service-"));
  const opened = openSshTargetTestStore(directory);
  registry = opened.store;
  closeStore = () => opened.connection.close();
  writeFileSync(join(directory, "ssh"), `#!${process.execPath}\n${FAKE_SSH}`, { mode: 0o700 });
});

afterEach(() => {
  closeStore();
  rmSync(directory, { recursive: true, force: true });
});

function service(
  overrides: { readonly mode?: string; readonly identity?: object; readonly facts?: object } = {},
) {
  return new SshTargetConnectionService({
    store: registry,
    buildVersion: BUILD,
    sshExecutable: join(directory, "ssh"),
    environment: {
      PATH: process.env.PATH,
      FAKE_SSH_ARGS: join(directory, "args.json"),
      FAKE_SSH_REQUEST: join(directory, "request.json"),
      FAKE_HOST_KEY: HOST_KEY,
      FAKE_SSH_MODE: overrides.mode ?? "executor",
      FAKE_IDENTITY: JSON.stringify(overrides.identity ?? passingFacts().identity),
      FAKE_FACTS: JSON.stringify(overrides.facts ?? passingFacts()),
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
    expect(args).toContain(`UserKnownHostsFile="${pin}"`);
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

  it("names the refusal for a changed host key, a missing executor, an executor of another build, and a session lost mid-attestation", async () => {
    const cases = [
      ["host-key-changed", {}, "host-key-changed"],
      ["executor-missing", {}, "executor-missing"],
      ["not-an-executor", {}, "executor-version-mismatch"],
      ["exits-after-introduction", {}, "target-unreachable"],
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
      expect(status.connection).toBe(reason === "target-unreachable" ? "unreachable" : reason);
      for (const entry of status.admission) {
        expect(entry.decision).toEqual({ status: "refused", reason });
      }
      connections.close();
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

  it("admits a placed provider runtime only in a posture its driver declares, and refuses a driver that declares none", async () => {
    const connections = service();
    const status = await registered(connections);
    const declared = {
      remotePlacement: { postures: ["plan"], appToolTransport: "stdio" },
    } as const;
    const decide = (
      driver: Parameters<SshTargetConnectionService["admitProviderRuntime"]>[1],
      posture: "plan" | "approval-gated" | "full-access",
    ) =>
      connections.admitProviderRuntime(status.target.id, driver, {
        posture,
        permissionPersistence: "project-default",
      });
    const notAttestable = { status: "refused", reason: "runtime-not-attestable" };

    expect(decide(declared, "plan")).toEqual({ status: "admitted" });
    // The attestation passes every confined posture; the driver's declaration
    // is what refuses these.
    expect(decide({}, "plan")).toEqual(notAttestable);
    expect(decide(declared, "approval-gated")).toEqual(notAttestable);
    expect(decide(declared, "full-access")).toEqual(notAttestable);
    expect(
      decide(
        { remotePlacement: { postures: ["plan"], appToolTransport: "loopback-listener" } },
        "plan",
      ),
    ).toEqual(notAttestable);

    connections.close();
    expect(decide(declared, "plan")).toEqual({ status: "refused", reason: "target-unreachable" });
  });

  it("binds a remote root and reads through the attested session, and on an unattested target refuses both before any frame", async () => {
    const remoteRoot = Schema.decodeUnknownSync(SshRemotePath)("/home/build/app");
    const requests = () =>
      readFileSync(join(directory, "request.json.log"), "utf8").trim().split("\n");

    const connections = service();
    const projects = new SshRemoteProjectService({
      store: registry,
      connections,
      uuid: () => "55555555-5555-4555-8555-555555555555",
      clock: () => "2026-10-26T10:00:00.000Z",
    });
    const status = await registered(connections);
    const bound = await projects.bind({ targetId: status.target.id, remoteRoot, name: "App" });
    // The journal keeps the folder the executor resolved.
    expect(bound).toMatchObject({ status: "ok", value: { remoteRoot: "/srv/app" } });
    if (bound.status !== "ok") return;
    const projectId = bound.value.id;
    expect(await projects.listDirectory({ projectId })).toEqual({
      status: "ok",
      value: { entries: [{ kind: "file", path: "README.md", byteLength: 6 }], truncated: false },
    });
    expect(await projects.gitStatus({ projectId })).toMatchObject({
      status: "ok",
      value: { head: { kind: "unborn", name: "main" } },
    });
    expect(requests()).toEqual(["attest", "resolve-root", "list-directory", "git-status"]);

    // The session ends: its attestation goes with it, and no read is sent.
    connections.close();
    expect(await projects.gitStatus({ projectId })).toEqual({
      status: "refused",
      reason: "not-admitted",
      decision: { status: "refused", reason: "target-unreachable" },
    });
    expect(requests()).toHaveLength(4);

    // A target whose Plan canary proved nothing is connected but not attested
    // for reads: binding and reading refuse with the probe that did not report.
    const facts = passingFacts();
    const inconclusive = {
      ...facts,
      canaries: facts.canaries.map((entry) =>
        entry.posture === "plan"
          ? {
              ...entry,
              results: entry.results.map((result) =>
                result.probe === "write-inside-root"
                  ? { ...result, outcome: "inconclusive" }
                  : result,
              ),
            }
          : entry,
      ),
    };
    const unattested = service({ facts: inconclusive });
    const unattestedProjects = new SshRemoteProjectService({
      store: registry,
      connections: unattested,
      uuid: () => "66666666-6666-4666-8666-666666666666",
      clock: () => "2026-10-26T10:00:00.000Z",
    });
    const reconnected = await unattested.connect(status.target.id);
    expect(reconnected).toMatchObject({ status: "ok", value: { connection: "connected" } });
    const refusal = {
      status: "refused",
      reason: "not-admitted",
      decision: {
        status: "refused",
        reason: "not-attested",
        posture: "plan",
        probe: "write-inside-root",
      },
    };
    expect(
      await unattestedProjects.bind({ targetId: status.target.id, remoteRoot, name: "Again" }),
    ).toEqual(refusal);
    expect(await unattestedProjects.listDirectory({ projectId })).toEqual(refusal);
    expect(await unattestedProjects.gitStatus({ projectId })).toEqual(refusal);
    expect(requests()).toEqual([
      "attest",
      "resolve-root",
      "list-directory",
      "git-status",
      "attest",
    ]);
    expect(unattestedProjects.list().map((project) => project.id)).toEqual([projectId]);
    unattested.close();
  });

  it("binds a turn's tools to the session it started on, tells the turn once when it ends, and sends nothing on the next", async () => {
    const requests = () =>
      readFileSync(join(directory, "request.json.log"), "utf8").trim().split("\n");
    const connections = service();
    const projects = new SshRemoteProjectService({
      store: registry,
      connections,
      uuid: () => "88888888-8888-4888-8888-888888888888",
      clock: () => "2026-10-26T10:00:00.000Z",
    });
    const status = await registered(connections);
    const bound = await projects.bind({
      targetId: status.target.id,
      remoteRoot: Schema.decodeUnknownSync(SshRemotePath)("/home/build/app"),
      name: "App",
    });
    if (bound.status !== "ok") throw new Error("bind refused");
    let posture: "plan" | "approval-gated" = "approval-gated";
    let disconnected = 0;
    const binding = bindSshRemoteHarness(
      { connections, uuid: () => "99999999-9999-4999-8999-999999999999" },
      {
        project: bound.value,
        scope: {
          threadId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          projectId: String(bound.value.id),
        },
        posture: () => ({ executionPolicy: posture, permissionPersistence: "current-session" }),
        onTargetDisconnected: () => {
          disconnected += 1;
        },
      },
    );
    if (binding.status !== "bound") throw new Error("binding refused");
    expect(await binding.filesystem.write({ path: "notes.md", content: "hi" })).toEqual({
      kind: "written",
      path: "notes.md",
      bytes: 2,
      created: true,
    });
    expect(
      await binding.shell.run({
        command: "bun test",
        cwd: binding.filesystem.root,
        timeoutMs: 1_000,
      }),
    ).toEqual({ status: "ran", exitCode: 0, output: "ran on /srv/app", truncated: false });
    // Plan runs no command: nothing is sent for one.
    posture = "plan";
    expect(
      await binding.shell.run({
        command: "bun test",
        cwd: binding.filesystem.root,
        timeoutMs: 1_000,
      }),
    ).toMatchObject({ status: "unavailable" });
    posture = "approval-gated";
    expect(requests()).toEqual(["attest", "resolve-root", "harness-file", "run-command"]);

    // The session ends and another attests: the turn is told once, and its
    // tools refuse rather than travel on a session that is not theirs.
    const again = await connections.connect(status.target.id);
    expect(again).toMatchObject({ status: "ok", value: { connection: "connected" } });
    expect(disconnected).toBe(1);
    expect(await binding.filesystem.write({ path: "notes.md", content: "again" })).toEqual({
      kind: "refused",
      reason: "target-unavailable",
    });
    expect(
      await binding.shell.run({
        command: "bun test",
        cwd: binding.filesystem.root,
        timeoutMs: 1_000,
      }),
    ).toMatchObject({ status: "unavailable" });
    expect(requests()).toEqual(["attest", "resolve-root", "harness-file", "run-command", "attest"]);
    binding.release();

    // A target with no session binds no tools; the decision says why.
    connections.close();
    expect(
      bindSshRemoteHarness(
        { connections, uuid: () => "99999999-9999-4999-8999-999999999999" },
        {
          project: bound.value,
          scope: {
            threadId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            projectId: String(bound.value.id),
          },
          posture: () => ({
            executionPolicy: "approval-gated",
            permissionPersistence: "current-session",
          }),
          onTargetDisconnected: () => undefined,
        },
      ),
    ).toEqual({ status: "refused", decision: { status: "refused", reason: "target-unreachable" } });
    expect(disconnected).toBe(1);
  });

  it("ends the session when the executor answers a read out of turn, and reads nothing after it", async () => {
    const connections = service({ mode: "answers-out-of-turn" });
    const projects = new SshRemoteProjectService({
      store: registry,
      connections,
      uuid: () => "77777777-7777-4777-8777-777777777777",
      clock: () => "2026-10-26T10:00:00.000Z",
    });
    const status = await registered(connections);
    expect(status.connection).toBe("connected");
    const remoteRoot = Schema.decodeUnknownSync(SshRemotePath)("/home/build/app");
    expect(await projects.bind({ targetId: status.target.id, remoteRoot, name: "App" })).toEqual({
      status: "refused",
      reason: "executor-unavailable",
    });
    expect(projects.list()).toEqual([]);
    expect(connections.list()[0]?.connection).toBe("unreachable");
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
