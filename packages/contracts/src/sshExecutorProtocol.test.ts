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
});
