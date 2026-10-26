import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import { SshAdmissionDecision, SshAttestation, SshTarget } from "./sshTarget";

const target = {
  id: "11111111-1111-4111-8111-111111111111",
  destination: "build@devbox.example",
  hostKey: {
    algorithm: "ssh-ed25519",
    publicKey: "AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl",
  },
  remoteUser: "build",
  platform: "linux",
  executorPath: "/opt/octant/bin/octant",
};

describe("SSH target contracts", () => {
  it("refuses a destination the SSH client would read as an option or split", () => {
    const decode = Schema.decodeUnknownEither(SshTarget);
    expect(decode(target)._tag).toBe("Right");
    for (const destination of ["-oProxyCommand=sh", "dev box", "devbox\u0007", ""]) {
      expect(decode({ ...target, destination })._tag).toBe("Left");
    }
    expect(decode({ ...target, executorPath: "octant" })._tag).toBe("Left");
  });

  it("refuses a target on a platform the confinement port does not support", () => {
    expect(Schema.decodeUnknownEither(SshTarget)({ ...target, platform: "windows" })._tag).toBe(
      "Left",
    );
  });

  it("decodes an attestation from an unsupported platform as data the host can refuse", () => {
    const attestation = Schema.decodeUnknownSync(SshAttestation)({
      connectionId: "22222222-2222-4222-8222-222222222222",
      facts: {
        identity: { buildVersion: "0.9.0", protocolVersion: 1, installVerified: true },
        platform: { operatingSystem: "freebsd", architecture: "x64", uid: 1001 },
        backend: { kind: "none" },
        canaries: [],
      },
    });
    expect(attestation.facts.platform.operatingSystem).toBe("freebsd");
  });

  it("carries the posture and the escaped action on a canary refusal and nothing more", () => {
    const decode = Schema.decodeUnknownEither(SshAdmissionDecision);
    const escaped = {
      status: "refused",
      reason: "confinement-canary-escaped",
      posture: "plan",
      probe: "open-network-socket",
    };
    expect(decode(escaped)._tag).toBe("Right");
    expect(decode({ ...escaped, detail: "shell output" })._tag).toBe("Left");
    expect(decode({ status: "refused", reason: "confinement-canary-escaped" })._tag).toBe("Left");
  });
});
