import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import { SshExecutorFrame, SshExecutorHostFrame } from "./sshExecutorProtocol";

const facts = {
  identity: { buildVersion: "0.9.0", protocolVersion: 1, installVerified: true },
  platform: { operatingSystem: "linux", architecture: "x64", uid: 1000 },
  backend: {
    kind: "bubblewrap",
    bwrapExecutable: true,
    unprivilegedUserNamespaces: true,
    binShExecutable: true,
  },
  canaries: [{ posture: "plan", results: [{ probe: "write-inside-root", outcome: "refused" }] }],
};

describe("SSH executor protocol", () => {
  it("reads only an introduction or a reply from the executor, never a request of its own", () => {
    const decode = Schema.decodeUnknownEither(SshExecutorFrame);
    expect(decode({ type: "hello", identity: facts.identity })._tag).toBe("Right");
    expect(
      decode({ type: "reply", id: 1, reply: { kind: "attested", remoteUser: "build", facts } })
        ._tag,
    ).toBe("Right");
    expect(decode({ type: "request", id: 1, request: { kind: "attest", postures: [] } })._tag).toBe(
      "Left",
    );
    expect(
      decode({ type: "reply", id: 1, reply: { kind: "attested", facts, admitted: true } })._tag,
    ).toBe("Left");
    expect(decode({ type: "reply", id: 0, reply: { kind: "busy" } })._tag).toBe("Left");
  });

  it("lets the host ask for reads only by a bound root and a path that stays inside it", () => {
    const decode = Schema.decodeUnknownEither(SshExecutorHostFrame);
    const request = (value: object) => decode({ type: "request", id: 3, request: value })._tag;
    expect(request({ kind: "read-file", root: "/home/build/app", path: "src/main.ts" })).toBe(
      "Right",
    );
    expect(request({ kind: "git-diff", root: "/home/build/app" })).toBe("Right");
    for (const path of ["../.ssh/id_ed25519", "/etc/passwd", "src/../../x", "src\u0000x", ""]) {
      expect(request({ kind: "read-file", root: "/home/build/app", path })).toBe("Left");
    }
    expect(request({ kind: "list-directory", root: "home/build/app" })).toBe("Left");
    // No read writes: there is no request that could.
    expect(request({ kind: "write-file", root: "/home/build/app", path: "a", content: "" })).toBe(
      "Left",
    );
  });

  it("reads a read refusal only with a reason the host can show", () => {
    const decode = Schema.decodeUnknownEither(SshExecutorFrame);
    expect(
      decode({ type: "reply", id: 2, reply: { kind: "refused", reason: "outside-root" } })._tag,
    ).toBe("Right");
    expect(
      decode({ type: "reply", id: 2, reply: { kind: "refused", reason: "ask the user" } })._tag,
    ).toBe("Left");
  });

  it("lets the host ask only for an attestation of named postures and probes", () => {
    const decode = Schema.decodeUnknownEither(SshExecutorHostFrame);
    expect(
      decode({
        type: "request",
        id: 7,
        request: {
          kind: "attest",
          postures: [{ posture: "plan", probes: ["write-inside-root", "open-network-socket"] }],
        },
      })._tag,
    ).toBe("Right");
    expect(
      decode({
        type: "request",
        id: 7,
        request: { kind: "attest", postures: [{ posture: "full-access", probes: [] }] },
      })._tag,
    ).toBe("Left");
    expect(decode({ type: "request", id: 7, request: { kind: "run", command: "id" } })._tag).toBe(
      "Left",
    );
  });

  it("asks for a command only in a posture that runs one, on the network that posture allows", () => {
    const decode = Schema.decodeUnknownEither(SshExecutorHostFrame);
    const command = (value: object) =>
      decode({
        type: "request",
        id: 9,
        request: {
          kind: "run-command",
          root: "/home/build/app",
          command: "bun test",
          timeoutMs: 120_000,
          ...value,
        },
      })._tag;
    const token = "a".repeat(64);
    expect(command({ posture: "approval-gated", network: "proxied", egressToken: token })).toBe(
      "Right",
    );
    expect(command({ posture: "auto-accept-edits", network: "none" })).toBe("Right");
    expect(command({ posture: "full-access", network: "allow" })).toBe("Right");
    // Plan runs no command; the target's own network is Full access's alone;
    // a proxied command carries its launch's token and no other command does.
    expect(command({ posture: "plan", network: "none" })).toBe("Left");
    expect(command({ posture: "approval-gated", network: "allow" })).toBe("Left");
    expect(command({ posture: "approval-gated", network: "proxied" })).toBe("Left");
    expect(command({ posture: "full-access", network: "allow", egressToken: token })).toBe("Left");
    expect(command({ posture: "approval-gated", network: "none", timeoutMs: 600_001 })).toBe(
      "Left",
    );
  });

  it("dials only checked addresses on host-opened streams and resolves only rule-shaped names", () => {
    const host = Schema.decodeUnknownEither(SshExecutorHostFrame);
    expect(host({ type: "dial", stream: 2, address: "93.184.216.34", port: 443 })._tag).toBe(
      "Right",
    );
    expect(host({ type: "dial", stream: 2, address: "2001:db8::1", port: 443 })._tag).toBe("Right");
    expect(host({ type: "dial", stream: 3, address: "93.184.216.34", port: 443 })._tag).toBe(
      "Left",
    );
    expect(host({ type: "dial", stream: 2, address: "example.com", port: 443 })._tag).toBe("Left");
    expect(host({ type: "resolve", question: 1, host: "registry.npmjs.org" })._tag).toBe("Right");
    for (const name of ["localhost", "127.0.0.1", "-oProxyCommand=x", "a b.example"]) {
      expect(host({ type: "resolve", question: 1, host: name })._tag).toBe("Left");
    }
    const executor = Schema.decodeUnknownEither(SshExecutorFrame);
    expect(executor({ type: "stream-open", stream: 1 })._tag).toBe("Right");
    expect(executor({ type: "stream-open", stream: 2 })._tag).toBe("Left");
    // The executor never dials or resolves on its own initiative.
    expect(executor({ type: "dial", stream: 2, address: "10.0.0.1", port: 22 })._tag).toBe("Left");
    expect(executor({ type: "stream-credit", stream: 1, bytes: 262_145 })._tag).toBe("Left");
  });

  it("names the reader of every harness file tool, with the tool's own arguments", () => {
    const decode = Schema.decodeUnknownEither(SshExecutorHostFrame);
    const file = (value: object) =>
      decode({
        type: "request",
        id: 4,
        request: { kind: "harness-file", root: "/home/build/app", ...value },
      })._tag;
    const reader = "00000000-0000-4000-8000-000000000001";
    expect(file({ reader, operation: { tool: "read", arguments: { path: "src/a.ts" } } })).toBe(
      "Right",
    );
    expect(file({ operation: { tool: "read", arguments: { path: "src/a.ts" } } })).toBe("Left");
    expect(file({ reader, operation: { tool: "bash", arguments: { command: "id" } } })).toBe(
      "Left",
    );
    expect(
      file({
        reader,
        operation: { tool: "write", arguments: { path: "a", content: "x", mode: 7 } },
      }),
    ).toBe("Left");
  });
});
