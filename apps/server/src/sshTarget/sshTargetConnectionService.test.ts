import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Exit, Fiber, Schema, Scope, Stream } from "effect";
import { decodeProviderInstanceId, type ProviderFailure } from "@octant/contracts";
import type { ProviderRemoteProcessPlacement } from "@octant/provider-sdk/driver";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  SshDestination,
  SshExecutorPath,
  SshRemotePath,
  SshTargetId,
} from "@octant/contracts/ssh-target";
import {
  SSH_EXECUTOR_PREAMBLE,
  SSH_EXECUTOR_PROTOCOL_VERSION,
} from "@octant/contracts/ssh-executor-protocol";
import {
  SSH_CANARY_PROBES_BY_POSTURE,
  SSH_RUNTIME_CANARY_PROBES_BY_POSTURE,
} from "@octant/domain/ssh-target-admission-policy";
import { bindSshRemoteHarness } from "./sshRemoteHarness";
import { decodeCodeTerminalId } from "@octant/contracts/code";
import { WindowId } from "@octant/contracts/shell";
import { SshRemoteProjectService } from "./sshRemoteProjectService";
import { SshRemoteTerminalService } from "./sshRemoteTerminalService";
import type { ProviderRuntimeEgress } from "./providerRuntimeEgress";
import {
  SshTargetConnectionService,
  type SshTargetPlacementInput,
} from "./sshTargetConnectionService";
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
const decodeWindowId = Schema.decodeUnknownSync(WindowId);
const executorPath = Schema.decodeUnknownSync(SshExecutorPath)("/opt/octant/bin/octant");
const remotePath = Schema.decodeUnknownSync(SshRemotePath);
const decodeTargetId = Schema.decodeUnknownSync(SshTargetId);

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
    case "open-terminal":
      if (mode === "terminals-full") return { kind: "terminal-unavailable" };
      setTimeout(() => process.stdout.write(frame({ type: "terminal-output", terminal: request.terminal, data: Buffer.from("shell in " + request.root + "\r\n$ ").toString("base64") })), 10);
      return { kind: "terminal-opened" };
    case "create-worktree":
      return { kind: "worktree-created", path: "/srv/.octant-worktrees/" + request.project + "/" + request.name, branch: "octant/" + request.name };
    case "remove-worktree":
      return { kind: "worktree-removed" };
    case "start-process":
      placed.add(request.stream);
      return { kind: "process-started", stream: request.stream };
    default:
      return { kind: "refused", reason: "read-failed" };
  }
};
// A placed process here echoes what it is sent, and ends when it is stopped.
const placed = new Set();
let buffered = Buffer.alloc(0);
process.stdin.on("data", (chunk) => {
  buffered = Buffer.concat([buffered, chunk]);
  while (buffered.length >= 4 && buffered.length >= 4 + buffered.readUInt32BE(0)) {
    const length = buffered.readUInt32BE(0);
    const request = JSON.parse(buffered.subarray(4, 4 + length).toString());
    buffered = buffered.subarray(4 + length);
    if (request.type === "terminal-input") {
      fs.appendFileSync(process.env.FAKE_SSH_REQUEST + ".log", "terminal-input\n");
      process.stdout.write(frame({ type: "terminal-output", terminal: request.terminal, data: request.data }));
      continue;
    }
    if (request.type === "terminal-close") {
      process.stdout.write(frame({ type: "terminal-exited", terminal: request.terminal, exitCode: 0 }));
      continue;
    }
    if (request.type === "stream-data" && placed.has(request.stream)) {
      process.stdout.write(frame({ type: "stream-data", stream: request.stream, data: request.data }));
      continue;
    }
    if (request.type === "stop-process" && placed.has(request.stream)) {
      placed.delete(request.stream);
      fs.appendFileSync(process.env.FAKE_SSH_REQUEST + ".log", "stop-process\n");
      process.stdout.write(frame({ type: "stream-end", stream: request.stream }));
      process.stdout.write(frame({ type: "process-ended", stream: request.stream, signal: "SIGTERM", stderr: "" }));
      continue;
    }
    if (request.type !== "request") continue;
    if (request.request.kind === "attest") fs.writeFileSync(process.env.FAKE_SSH_REQUEST, JSON.stringify(request));
    if (request.request.kind === "start-process") fs.writeFileSync(process.env.FAKE_SSH_REQUEST + ".start-process", JSON.stringify(request));
    fs.appendFileSync(process.env.FAKE_SSH_REQUEST + ".log", request.request.kind + "\n");
    const outOfTurn = mode === "answers-out-of-turn" && request.request.kind !== "attest";
    process.stdout.write(frame({ type: "reply", id: request.id + (outOfTurn ? 1 : 0), reply: answer(request.request) }));
  }
});
process.stdin.on("end", () => process.exit(0));
`;

function passingFacts() {
  return {
    identity: {
      buildVersion: BUILD,
      protocolVersion: SSH_EXECUTOR_PROTOCOL_VERSION,
      installVerified: true,
    },
    platform: { operatingSystem: "linux", architecture: "x64", uid: 1000 },
    backend: {
      kind: "bubblewrap",
      bwrapExecutable: true,
      unprivilegedUserNamespaces: true,
      binShExecutable: true,
    },
    canaries: (["plan", "approval-gated", "auto-accept-edits"] as const).map((posture) => ({
      posture,
      results: [
        ...SSH_CANARY_PROBES_BY_POSTURE[posture],
        ...SSH_RUNTIME_CANARY_PROBES_BY_POSTURE[posture],
      ].map((probe) => ({
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
  overrides: {
    readonly mode?: string;
    readonly identity?: object;
    readonly facts?: object;
    readonly runtimeEgress?: ProviderRuntimeEgress;
  } = {},
) {
  return new SshTargetConnectionService({
    ...(overrides.runtimeEgress === undefined ? {} : { runtimeEgress: overrides.runtimeEgress }),
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
    // Each posture's own probes, then a placed runtime's grant shape in it.
    expect(request.request.postures).toEqual(
      (["plan", "approval-gated", "auto-accept-edits"] as const).map((posture) => ({
        posture,
        probes: [
          ...SSH_CANARY_PROBES_BY_POSTURE[posture],
          ...SSH_RUNTIME_CANARY_PROBES_BY_POSTURE[posture],
        ],
      })),
    );
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
        {
          buildVersion: "0.8.9",
          protocolVersion: SSH_EXECUTOR_PROTOCOL_VERSION,
          installVerified: true,
        },
        "executor-version-mismatch",
      ],
      [
        "executor",
        {
          buildVersion: BUILD,
          protocolVersion: SSH_EXECUTOR_PROTOCOL_VERSION,
          installVerified: false,
        },
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

  it("opens terminals and creates worktrees only where the approval-gated posture attested, refusing elsewhere before any frame", async () => {
    const remoteRoot = Schema.decodeUnknownSync(SshRemotePath)("/home/build/app");
    const requests = () =>
      readFileSync(join(directory, "request.json.log"), "utf8").trim().split("\n");
    const windowId = decodeWindowId("77777777-7777-4777-8777-777777777777");
    let next = 0;
    const uuid = () => `88888888-8888-4888-8888-${String(++next).padStart(12, "0")}`;

    const connections = service();
    const projects = new SshRemoteProjectService({
      store: registry,
      connections,
      uuid,
      clock: () => "2026-10-26T10:00:00.000Z",
    });
    const terminals = new SshRemoteTerminalService({ projects, connections, store: registry });
    const status = await registered(connections);
    const bound = await projects.bind({ targetId: status.target.id, remoteRoot, name: "App" });
    if (bound.status !== "ok") throw new Error("bind refused");
    const projectId = bound.value.id;

    // A worktree is the folder the executor made, journaled with its session.
    const created = await projects.createWorktree({ projectId, name: "fix-login" });
    expect(created).toMatchObject({
      status: "ok",
      value: {
        projectId,
        name: "fix-login",
        branch: "octant/fix-login",
        path: `/srv/.octant-worktrees/${String(projectId)}/fix-login`,
      },
    });
    if (created.status !== "ok") return;
    expect(projects.listWorktrees().map((worktree) => worktree.id)).toEqual([created.value.id]);
    expect(await projects.createWorktree({ projectId, name: "fix-login" })).toEqual({
      status: "refused",
      reason: "worktree-exists",
    });

    // A terminal in the worktree runs there, approval-gated, and is the
    // opening window's alone.
    const terminalId = decodeCodeTerminalId("99999999-9999-4999-8999-999999999991");
    const started = await terminals.execute(windowId, {
      kind: "start",
      projectId,
      terminalId,
      worktreeId: created.value.id,
      columns: 80,
      rows: 24,
    });
    expect(started).toMatchObject({
      kind: "project-terminal",
      terminal: { state: "running", posture: "approval-gated" },
    });
    const output = async () => {
      const read = await terminals.execute(windowId, {
        kind: "read-output",
        projectId,
        terminalId,
        afterCharacters: 0,
      });
      return read.kind === "project-terminal" ? read.output?.text : read.message;
    };
    const prompt = `shell in /srv/.octant-worktrees/${String(projectId)}/fix-login\r\n$ `;
    await expect.poll(output).toBe(prompt);
    await terminals.execute(windowId, { kind: "write", projectId, terminalId, data: "ls\r" });
    await expect.poll(output).toBe(`${prompt}ls\r`);
    expect(
      await terminals.execute(decodeWindowId("77777777-7777-4777-8777-000000000000"), {
        kind: "attach",
        projectId,
        terminalId,
      }),
    ).toMatchObject({ kind: "project-terminal-refused", reason: "unauthorized" });
    expect(registry.runningTerminals()).toEqual([terminalId]);

    // The session ends: the shell died with it, and the record says so.
    connections.close();
    await expect
      .poll(async () => {
        const view = await terminals.execute(windowId, { kind: "attach", projectId, terminalId });
        return view.kind === "project-terminal" ? view.terminal.state : view.reason;
      })
      .toBe("interrupted");
    expect(registry.runningTerminals()).toEqual([]);
    const sent = requests().length;

    // A target whose approval-gated canary proved nothing still reads in Plan,
    // and opens no terminal and changes no worktree, sending nothing.
    const facts = passingFacts();
    const unattested = service({
      facts: {
        ...facts,
        canaries: facts.canaries.map((entry) =>
          entry.posture === "approval-gated"
            ? {
                ...entry,
                results: entry.results.map((result) =>
                  result.probe === "write-outside-root"
                    ? { ...result, outcome: "inconclusive" }
                    : result,
                ),
              }
            : entry,
        ),
      },
    });
    const unattestedProjects = new SshRemoteProjectService({
      store: registry,
      connections: unattested,
      uuid,
      clock: () => "2026-10-26T10:00:00.000Z",
    });
    const unattestedTerminals = new SshRemoteTerminalService({
      projects: unattestedProjects,
      connections: unattested,
      store: registry,
    });
    await unattested.connect(status.target.id);
    const refusal = {
      status: "refused",
      reason: "not-admitted",
      decision: {
        status: "refused",
        reason: "not-attested",
        posture: "approval-gated",
        probe: "write-outside-root",
      },
    };
    expect(await unattestedProjects.createWorktree({ projectId, name: "other" })).toEqual(refusal);
    expect(await unattestedProjects.removeWorktree({ worktreeId: created.value.id })).toEqual(
      refusal,
    );
    expect(
      await unattestedTerminals.execute(windowId, {
        kind: "start",
        projectId,
        terminalId: decodeCodeTerminalId("99999999-9999-4999-8999-999999999992"),
        columns: 80,
        rows: 24,
      }),
    ).toEqual({
      kind: "project-terminal-refused",
      reason: "unavailable",
      message:
        "The target could not show that approval-gated work is confined (write-outside-root). Connect it again to attest.",
    });
    expect(await unattestedProjects.gitStatus({ projectId })).toMatchObject({ status: "ok" });
    expect(requests().slice(sent)).toEqual(["attest", "git-status"]);
    unattested.close();

    // Once attested again, the worktree is removed and its record goes.
    const again = service();
    const againProjects = new SshRemoteProjectService({
      store: registry,
      connections: again,
      uuid,
      clock: () => "2026-10-26T10:00:00.000Z",
    });
    await again.connect(status.target.id);
    expect(await againProjects.removeWorktree({ worktreeId: created.value.id })).toEqual({
      status: "ok",
      value: null,
    });
    expect(againProjects.listWorktrees()).toEqual([]);
    again.close();
  });

  it("tells the person the target opened no terminal, not that its session ended, when the executor holds its most", async () => {
    const remoteRoot = Schema.decodeUnknownSync(SshRemotePath)("/home/build/app");
    const connections = service({ mode: "terminals-full" });
    const projects = new SshRemoteProjectService({
      store: registry,
      connections,
      uuid: () => "88888888-8888-4888-8888-000000000001",
      clock: () => "2026-10-26T10:00:00.000Z",
    });
    const terminals = new SshRemoteTerminalService({ projects, connections, store: registry });
    const status = await registered(connections);
    const bound = await projects.bind({ targetId: status.target.id, remoteRoot, name: "App" });
    if (bound.status !== "ok") throw new Error("bind refused");

    expect(
      await terminals.execute(decodeWindowId("77777777-7777-4777-8777-777777777777"), {
        kind: "start",
        projectId: bound.value.id,
        terminalId: decodeCodeTerminalId("99999999-9999-4999-8999-999999999993"),
        columns: 80,
        rows: 24,
      }),
    ).toEqual({
      kind: "project-terminal-refused",
      reason: "unavailable",
      message:
        "The target opened no terminal: this connection already holds its most, or the target cannot open one. Close a terminal and retry.",
    });
    expect(registry.runningTerminals()).toEqual([]);
    // The session is still there to carry the next request.
    expect(await projects.gitStatus({ projectId: bound.value.id })).toMatchObject({ status: "ok" });
    connections.close();
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

  it("places a runtime only where its posture's runtime canaries passed, refusing before any frame elsewhere", async () => {
    const requests = () =>
      readFileSync(join(directory, "request.json.log"), "utf8").trim().split("\n");
    const facts = passingFacts();
    // The approval-gated runtime grant shape did not show it keeps ~/.ssh out.
    const unproven = {
      ...facts,
      canaries: facts.canaries.map((entry) =>
        entry.posture === "approval-gated"
          ? {
              ...entry,
              results: entry.results.map((result) =>
                result.probe === "runtime-read-ssh-directory"
                  ? { ...result, outcome: "inconclusive" }
                  : result,
              ),
            }
          : entry,
      ),
    };
    let proxies = 0;
    let proxiesClosed = 0;
    const connections = service({
      facts: unproven,
      runtimeEgress: {
        start: async () => {
          proxies += 1;
          return {
            status: "listening",
            endpoint: { kind: "unix-socket", path: join(directory, "runtime-proxy.sock") },
            token: "b".repeat(64),
            close: async () => {
              proxiesClosed += 1;
            },
          };
        },
      },
    });
    const status = await registered(connections);
    const session = connections.session(status.target.id);
    if (session === undefined) throw new Error("no session");

    const refused = await launchExit(placeOn(connections, placementOn(session, "approval-gated")));
    expect(refused).toMatchObject({ category: "unavailable" });
    expect(proxies).toBe(0);
    expect(requests()).toEqual(["attest"]);
    // Commands in that posture are still admitted; only the runtime grant shape is unproven.
    expect(
      connections.admit(status.target.id, {
        posture: "approval-gated",
        permissionPersistence: "current-session",
        subject: { kind: "octant-launch" },
      }),
    ).toEqual({ status: "admitted" });

    // Plan's runtime canaries passed, and Plan's runtime runs on a proxy of its own too.
    const scope = Effect.runSync(Scope.make());
    const placed = await Effect.runPromise(
      Scope.extend(
        placeOn(connections, placementOn(session, "plan")).launch({
          executable: "/opt/agent/bin/agent",
          args: ["--acp"],
        }),
        scope,
      ),
    );
    const output = Effect.runFork(
      placed.output.pipe(
        Stream.map((chunk) => Buffer.from(chunk).toString()),
        Stream.takeUntil((text) => text.includes("hello")),
        Stream.runCollect,
      ),
    );
    await Effect.runPromise(placed.write(Buffer.from("hello")));
    expect([...(await Effect.runPromise(Fiber.join(output)))].join("")).toBe("hello");
    expect(requests()).toEqual(["attest", "start-process"]);
    expect(proxies).toBe(1);
    expect(
      JSON.parse(readFileSync(join(directory, "request.json.start-process"), "utf8")).request,
    ).toMatchObject({ posture: "plan", network: "proxied", egressToken: "b".repeat(64) });
    await Effect.runPromise(Scope.close(scope, Exit.void));
    expect(requests()).toEqual(["attest", "start-process", "stop-process"]);
    expect(proxiesClosed).toBe(1);
    connections.close();
  });

  it("ends a placed runtime with its session, and places nothing on the next session", async () => {
    const requests = () =>
      readFileSync(join(directory, "request.json.log"), "utf8").trim().split("\n");
    const connections = service({ runtimeEgress: listeningEgress() });
    const status = await registered(connections);
    const session = connections.session(status.target.id);
    if (session === undefined) throw new Error("no session");
    const placement = placeOn(connections, placementOn(session, "plan"));
    const scope = Effect.runSync(Scope.make());
    const placed = await Effect.runPromise(
      Scope.extend(placement.launch({ executable: "/opt/agent/bin/agent", args: [] }), scope),
    );
    await connections.connect(status.target.id);
    expect(await Effect.runPromise(placed.ended)).toEqual({ kind: "lost" });
    // The placement named the session that ended; the next one is not borrowed.
    expect(await launchExit(placement)).toMatchObject({ category: "unavailable" });
    expect(requests().filter((kind) => kind === "start-process")).toHaveLength(1);
    await Effect.runPromise(Scope.close(scope, Exit.void));
    connections.close();
  });

  it("refuses a launch whose arguments or home cannot be placed, without a frame and keeping the session", async () => {
    const requests = () =>
      readFileSync(join(directory, "request.json.log"), "utf8").trim().split("\n");
    const connections = service();
    const status = await registered(connections);
    const session = connections.session(status.target.id);
    if (session === undefined) throw new Error("no session");
    const failure = async (input: SshTargetPlacementInput, args: ReadonlyArray<string>) => {
      const exit = await Effect.runPromiseExit(
        Effect.scoped(
          placeOn(connections, input).launch({ executable: "/opt/agent/bin/agent", args }),
        ),
      );
      return Exit.isFailure(exit) && exit.cause._tag === "Fail" ? exit.cause.error : undefined;
    };
    for (const args of [["a\u0000b"], ["x".repeat(4_097)], Array.from({ length: 65 }, () => "x")]) {
      expect(await failure(placementOn(session, "plan"), args)).toMatchObject({
        category: "invalid-configuration",
      });
    }
    expect(
      await failure({ ...placementOn(session, "plan"), projectId: "not-a-project" }, []),
    ).toMatchObject({ category: "invalid-configuration" });
    const fiveStates = await Effect.runPromiseExit(
      Effect.scoped(
        placeOn(connections, placementOn(session, "plan")).launch({
          executable: "/opt/agent/bin/agent",
          args: [],
          accountState: Array.from({ length: 5 }, (_, index) => ({
            path: `.agent${String(index)}`,
            access: "read-only" as const,
          })),
        }),
      ),
    );
    expect(
      Exit.isFailure(fiveStates) && fiveStates.cause._tag === "Fail"
        ? fiveStates.cause.error
        : undefined,
    ).toMatchObject({ category: "invalid-configuration" });
    // Nothing reached the executor, and the session every other launch shares is still up.
    expect(requests()).toEqual(["attest"]);
    expect(connections.session(status.target.id)?.connectionId).toBe(session.connectionId);
    connections.close();
  });

  it("places a runtime only at the path the person set for its provider on the target, refusing any other before any frame", async () => {
    const requests = () =>
      readFileSync(join(directory, "request.json.log"), "utf8").trim().split("\n");
    const connections = service({ runtimeEgress: listeningEgress() });
    const status = await registered(connections);
    const session = connections.session(status.target.id);
    if (session === undefined) throw new Error("no session");
    const input = placementOn(session, "plan");
    // Nothing set for this provider on this target: there is no placement.
    expect(connections.placement(input)).toMatchObject({
      status: "refused",
      failure: { category: "invalid-configuration" },
    });
    const placement = placeOn(connections, input);
    expect(placement.executable).toBe(AGENT);
    expect(connections.list()[0]?.runtimeBinaries).toEqual([
      { providerInstanceId: input.providerInstanceId, path: AGENT },
    ]);
    // A path of the driver's own, or the model's, never reaches the executor.
    expect(await launchExit(placement, "/srv/app/tools/agent")).toMatchObject({
      category: "invalid-configuration",
    });
    // Once the person points the provider elsewhere, the old placement starts nothing.
    expect(
      connections.setRuntimeBinary({
        targetId: status.target.id,
        providerInstanceId: input.providerInstanceId,
        path: remotePath("/opt/agent-2/bin/agent"),
      }),
    ).toMatchObject({ status: "ok" });
    expect(await launchExit(placement)).toMatchObject({ category: "interrupted" });
    expect(requests()).toEqual(["attest"]);
    expect(
      connections.setRuntimeBinary({
        targetId: decodeTargetId("99999999-9999-4999-8999-999999999999"),
        providerInstanceId: input.providerInstanceId,
        path: remotePath(AGENT),
      }),
    ).toMatchObject({ status: "refused", reason: "unknown-target" });
    connections.close();
  });

  it("places no runtime, in any posture, on a host without a runtime proxy", async () => {
    const requests = () =>
      readFileSync(join(directory, "request.json.log"), "utf8").trim().split("\n");
    const connections = service();
    const status = await registered(connections);
    const session = connections.session(status.target.id);
    if (session === undefined) throw new Error("no session");
    for (const posture of ["plan", "approval-gated"] as const) {
      expect(await launchExit(placeOn(connections, placementOn(session, posture)))).toMatchObject({
        category: "unavailable",
      });
    }
    expect(requests()).toEqual(["attest"]);
    connections.close();
  });
});

/** A runtime proxy that listens on a socket nothing serves; the fake executor never dials it. */
function listeningEgress(): ProviderRuntimeEgress {
  return {
    start: async () => ({
      status: "listening",
      endpoint: { kind: "unix-socket", path: join(directory, "runtime-proxy.sock") },
      token: "b".repeat(64),
      close: async () => undefined,
    }),
  };
}

/** The agent's path on the stand-in target, as the person set it there. */
const AGENT = "/opt/agent/bin/agent";

/** The placement for `input`, with the agent's path set on its target first. */
function placeOn(
  connections: SshTargetConnectionService,
  input: SshTargetPlacementInput,
): ProviderRemoteProcessPlacement {
  const set = connections.setRuntimeBinary({
    targetId: input.session.targetId,
    providerInstanceId: input.providerInstanceId,
    path: remotePath(AGENT),
  });
  if (set.status !== "ok") throw new Error(set.message);
  const placement = connections.placement(input);
  if (placement.status !== "placed") throw new Error(placement.failure.message);
  return placement.placement;
}

const placementDriver = {
  remotePlacement: { postures: ["plan", "approval-gated"], appToolTransport: "stdio" },
} as const;

function placementOn(
  session: SshTargetPlacementInput["session"],
  posture: "plan" | "approval-gated",
): SshTargetPlacementInput {
  return {
    session,
    driver: placementDriver,
    root: "/srv/app",
    projectId: "55555555-5555-4555-8555-555555555555",
    threadId: "66666666-6666-4666-8666-666666666666",
    providerInstanceId: decodeProviderInstanceId("77777777-7777-4777-8777-777777777777"),
    posture,
    permissionPersistence: "current-session",
    currentPosture: () => posture,
  };
}

/** The failure a launch through the placement ends with, or undefined when it started. */
async function launchExit(
  placement: ProviderRemoteProcessPlacement,
  executable = AGENT,
): Promise<ProviderFailure | undefined> {
  const exit = await Effect.runPromiseExit(
    Effect.scoped(placement.launch({ executable, args: [] })),
  );
  if (Exit.isSuccess(exit)) return undefined;
  const failure = exit.cause._tag === "Fail" ? exit.cause.error : undefined;
  return failure;
}
