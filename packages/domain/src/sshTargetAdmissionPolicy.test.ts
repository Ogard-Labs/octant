import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  SshConnectionId,
  type SshAttestation,
  type SshAttestationFacts,
  type SshConfinedPosture,
  type SshConfinementCanaryOutcome,
  type SshConfinementCanaryProbe,
} from "@octant/contracts/ssh-target";
import {
  SSH_CANARY_PROBES_BY_POSTURE,
  SSH_RUNTIME_CANARY_PROBES_BY_POSTURE,
  decideSshAdmission,
  type SshAdmissionRequest,
  type SshAdmissionSubject,
} from "./sshTargetAdmissionPolicy";

const connectionId = Schema.decodeUnknownSync(SshConnectionId);
const thisConnection = connectionId("11111111-1111-4111-8111-111111111111");
const previousConnection = connectionId("22222222-2222-4222-8222-222222222222");

const host = { buildVersion: "0.9.0+abc123", protocolVersion: 1 };
const CONFINED_POSTURES: ReadonlyArray<SshConfinedPosture> = [
  "plan",
  "approval-gated",
  "auto-accept-edits",
];
const OCTANT_SUBJECTS: ReadonlyArray<SshAdmissionSubject> = [
  { kind: "file-operation" },
  { kind: "octant-launch" },
];

function canaries(
  outcome: (
    posture: SshConfinedPosture,
    probe: SshConfinementCanaryProbe,
  ) => SshConfinementCanaryOutcome | "missing" = () => "refused",
): SshAttestationFacts["canaries"] {
  return CONFINED_POSTURES.map((posture) => ({
    posture,
    results: [
      ...SSH_CANARY_PROBES_BY_POSTURE[posture],
      ...SSH_RUNTIME_CANARY_PROBES_BY_POSTURE[posture],
    ].flatMap((probe) => {
      const result = outcome(posture, probe);
      return result === "missing" ? [] : [{ probe, outcome: result }];
    }),
  }));
}

function linuxFacts(overrides: Partial<SshAttestationFacts> = {}): SshAttestationFacts {
  return {
    identity: { buildVersion: host.buildVersion, protocolVersion: 1, installVerified: true },
    platform: { operatingSystem: "linux", architecture: "x64", uid: 1000 },
    backend: {
      kind: "bubblewrap",
      bwrapExecutable: true,
      unprivilegedUserNamespaces: true,
      binShExecutable: true,
    },
    canaries: canaries(),
    ...overrides,
  };
}

function macosFacts(overrides: Partial<SshAttestationFacts> = {}): SshAttestationFacts {
  return linuxFacts({
    platform: { operatingSystem: "darwin", architecture: "arm64", uid: 501 },
    backend: { kind: "seatbelt", sandboxExecExecutable: true },
    ...overrides,
  });
}

function attested(facts: SshAttestationFacts): SshAttestation {
  return { connectionId: thisConnection, facts };
}

function request(overrides: Partial<SshAdmissionRequest> = {}): SshAdmissionRequest {
  return {
    host,
    target: "registered",
    connection: { state: "connected", connectionId: thisConnection },
    attestation: attested(linuxFacts()),
    posture: "approval-gated",
    permissionPersistence: "current-session",
    subject: { kind: "octant-launch" },
    ...overrides,
  };
}

describe("SSH target admission", () => {
  it("admits Octant launches and file operations in every confined posture once that posture is attested", () => {
    for (const facts of [linuxFacts(), macosFacts()]) {
      for (const posture of CONFINED_POSTURES) {
        for (const subject of OCTANT_SUBJECTS) {
          expect(
            decideSshAdmission(request({ attestation: attested(facts), posture, subject })),
          ).toEqual({
            status: "admitted",
          });
        }
      }
    }
  });

  it("refuses with the reason for each fact the target did not prove", () => {
    const cases: ReadonlyArray<readonly [string, Partial<SshAdmissionRequest>, string]> = [
      ["the target was removed", { target: "removed" }, "target-removed"],
      [
        "the target cannot be reached",
        { connection: { state: "unreachable" } },
        "target-unreachable",
      ],
      [
        "this Mac's key or agent no longer signs in to the target",
        { connection: { state: "authentication-refused" } },
        "authentication-refused",
      ],
      [
        "the target presented a different host key",
        { connection: { state: "host-key-changed" } },
        "host-key-changed",
      ],
      ["no executor answered", { connection: { state: "executor-missing" } }, "executor-missing"],
      [
        "the executor that answered introduced itself as another build",
        { connection: { state: "executor-version-mismatch" } },
        "executor-version-mismatch",
      ],
      [
        "the executor is another build",
        {
          attestation: attested(
            linuxFacts({
              identity: { buildVersion: "0.8.9", protocolVersion: 1, installVerified: true },
            }),
          ),
        },
        "executor-version-mismatch",
      ],
      [
        "the executor speaks another protocol version",
        {
          attestation: attested(
            linuxFacts({
              identity: {
                buildVersion: host.buildVersion,
                protocolVersion: 2,
                installVerified: true,
              },
            }),
          ),
        },
        "executor-version-mismatch",
      ],
      [
        "the executor could not verify its own install",
        {
          attestation: attested(
            linuxFacts({
              identity: {
                buildVersion: host.buildVersion,
                protocolVersion: 1,
                installVerified: false,
              },
            }),
          ),
        },
        "executor-version-mismatch",
      ],
      [
        "the target runs neither Linux nor macOS",
        {
          attestation: attested(
            linuxFacts({
              platform: { operatingSystem: "freebsd", architecture: "x64", uid: 1000 },
              backend: { kind: "none" },
            }),
          ),
        },
        "unsupported-platform",
      ],
      [
        "the session logged in as root",
        {
          attestation: attested(
            linuxFacts({ platform: { operatingSystem: "linux", architecture: "x64", uid: 0 } }),
          ),
        },
        "remote-root-user",
      ],
      [
        "Linux has no executable bwrap",
        {
          attestation: attested(
            linuxFacts({
              backend: {
                kind: "bubblewrap",
                bwrapExecutable: false,
                unprivilegedUserNamespaces: true,
                binShExecutable: true,
              },
            }),
          ),
        },
        "confinement-backend-missing",
      ],
      [
        "Linux reports no backend at all",
        { attestation: attested(linuxFacts({ backend: { kind: "none" } })) },
        "confinement-backend-missing",
      ],
      [
        "macOS has no executable sandbox-exec",
        {
          attestation: attested(
            macosFacts({ backend: { kind: "seatbelt", sandboxExecExecutable: false } }),
          ),
        },
        "confinement-backend-missing",
      ],
      [
        "macOS reports the Linux backend",
        {
          attestation: attested(
            macosFacts({
              backend: {
                kind: "bubblewrap",
                bwrapExecutable: true,
                unprivilegedUserNamespaces: true,
                binShExecutable: true,
              },
            }),
          ),
        },
        "confinement-backend-missing",
      ],
      [
        "Linux refuses unprivileged user namespaces",
        {
          attestation: attested(
            linuxFacts({
              backend: {
                kind: "bubblewrap",
                bwrapExecutable: true,
                unprivilegedUserNamespaces: false,
                binShExecutable: true,
              },
            }),
          ),
        },
        "user-namespaces-unavailable",
      ],
      [
        "a Plan launch on Linux has no /bin/sh for its process filter",
        {
          posture: "plan",
          attestation: attested(
            linuxFacts({
              backend: {
                kind: "bubblewrap",
                bwrapExecutable: true,
                unprivilegedUserNamespaces: true,
                binShExecutable: false,
              },
            }),
          ),
        },
        "plan-filter-unavailable",
      ],
      [
        "a Plan launch on Linux runs on a CPU the process filter does not cover",
        {
          posture: "plan",
          attestation: attested(
            linuxFacts({
              platform: { operatingSystem: "linux", architecture: "riscv64", uid: 1000 },
            }),
          ),
        },
        "plan-filter-unavailable",
      ],
    ];
    for (const [, overrides, reason] of cases) {
      expect(decideSshAdmission(request(overrides))).toEqual({ status: "refused", reason });
    }
  });

  it("does not need the Plan process filter outside Plan", () => {
    const facts = linuxFacts({
      platform: { operatingSystem: "linux", architecture: "riscv64", uid: 1000 },
      backend: {
        kind: "bubblewrap",
        bwrapExecutable: true,
        unprivilegedUserNamespaces: true,
        binShExecutable: false,
      },
    });
    expect(
      decideSshAdmission(request({ attestation: attested(facts), posture: "approval-gated" })),
    ).toEqual({
      status: "admitted",
    });
  });

  it("requires every probe in the design's canary table for each confined posture", () => {
    expect(SSH_CANARY_PROBES_BY_POSTURE).toEqual({
      plan: [
        "write-inside-root",
        "exec-after-start",
        "fork-after-start",
        "open-network-socket",
        "read-sibling-folder",
        "read-other-session-runtime",
      ],
      "approval-gated": [
        "write-outside-root",
        "read-ssh-directory",
        "connect-bypassing-forwarder",
        "read-sibling-folder",
        "read-other-session-runtime",
      ],
      "auto-accept-edits": [
        "write-outside-root",
        "read-ssh-directory",
        "connect-bypassing-forwarder",
        "read-sibling-folder",
        "read-other-session-runtime",
      ],
    });
  });

  it("refuses a posture when any of its probes escaped, naming the posture and the action that succeeded", () => {
    for (const posture of CONFINED_POSTURES) {
      for (const probe of SSH_CANARY_PROBES_BY_POSTURE[posture]) {
        const facts = linuxFacts({
          canaries: canaries((p, q) => (p === posture && q === probe ? "escaped" : "refused")),
        });
        expect(decideSshAdmission(request({ attestation: attested(facts), posture }))).toEqual({
          status: "refused",
          reason: "confinement-canary-escaped",
          posture,
          probe,
        });
      }
    }
  });

  it("refuses a posture when any of its probes was inconclusive or missing, naming that probe", () => {
    for (const unproven of ["inconclusive", "missing"] as const) {
      for (const posture of CONFINED_POSTURES) {
        for (const probe of SSH_CANARY_PROBES_BY_POSTURE[posture]) {
          const facts = macosFacts({
            canaries: canaries((p, q) => (p === posture && q === probe ? unproven : "refused")),
          });
          expect(decideSshAdmission(request({ attestation: attested(facts), posture }))).toEqual({
            status: "refused",
            reason: "not-attested",
            posture,
            probe,
          });
        }
      }
    }
  });

  it("refuses a posture the attestation did not cover even when every other posture passed", () => {
    for (const posture of CONFINED_POSTURES) {
      const facts = linuxFacts({
        canaries: canaries().filter((entry) => entry.posture !== posture),
      });
      expect(decideSshAdmission(request({ attestation: attested(facts), posture }))).toEqual({
        status: "refused",
        reason: "not-attested",
        posture,
      });
    }
  });

  it("refuses a posture whose canaries passed in another posture's entry only", () => {
    const facts = linuxFacts({
      canaries: [
        {
          posture: "approval-gated",
          results: SSH_CANARY_PROBES_BY_POSTURE["auto-accept-edits"].map((probe) => ({
            probe,
            outcome: "refused" as const,
          })),
        },
      ],
    });
    expect(
      decideSshAdmission(request({ attestation: attested(facts), posture: "auto-accept-edits" })),
    ).toEqual({
      status: "refused",
      reason: "not-attested",
      posture: "auto-accept-edits",
    });
  });

  it("refuses a posture whose report repeats a probe as passing beside an inconclusive copy", () => {
    const facts = linuxFacts({
      canaries: [
        ...canaries(),
        { posture: "plan", results: [{ probe: "fork-after-start", outcome: "inconclusive" }] },
      ],
    });
    expect(decideSshAdmission(request({ attestation: attested(facts), posture: "plan" }))).toEqual({
      status: "refused",
      reason: "not-attested",
      posture: "plan",
      probe: "fork-after-start",
    });
  });

  it("refuses every posture on a connection where any canary escaped", () => {
    const facts = linuxFacts({
      canaries: canaries((posture, probe) =>
        posture === "plan" && probe === "open-network-socket" ? "escaped" : "refused",
      ),
    });
    for (const posture of ["approval-gated", "auto-accept-edits", "full-access"] as const) {
      expect(
        decideSshAdmission(
          request({
            attestation: attested(facts),
            posture,
            permissionPersistence: "project-default",
          }),
        ),
      ).toEqual({
        status: "refused",
        reason: "confinement-canary-escaped",
        posture: "plan",
        probe: "open-network-socket",
      });
    }
  });

  it("never admits on an attestation made on an earlier connection", () => {
    const stale: SshAttestation = { connectionId: previousConnection, facts: linuxFacts() };
    for (const posture of [...CONFINED_POSTURES, "full-access"] as const) {
      expect(
        decideSshAdmission(
          request({ attestation: stale, posture, permissionPersistence: "project-default" }),
        ),
      ).toEqual({
        status: "refused",
        reason: "not-attested",
        posture,
      });
    }
  });

  it("refuses everything while the host reconnects, naming the attempt and when the next one starts, whatever the last session attested", () => {
    const waiting = {
      state: "reconnecting",
      attempt: 2,
      maxAttempts: 8,
      nextAttemptAt: 1_700_000_004_000,
    } as const;
    for (const posture of [...CONFINED_POSTURES, "full-access"] as const) {
      for (const subject of OCTANT_SUBJECTS) {
        expect(
          decideSshAdmission(
            request({
              connection: waiting,
              posture,
              permissionPersistence: "project-default",
              subject,
            }),
          ),
        ).toEqual({
          status: "refused",
          reason: "target-reconnecting",
          attempt: 2,
          maxAttempts: 8,
          nextAttemptAt: 1_700_000_004_000,
        });
      }
    }
    // While the attempt runs there is no next time to name.
    expect(
      decideSshAdmission(
        request({ connection: { state: "reconnecting", attempt: 3, maxAttempts: 8 } }),
      ),
    ).toEqual({ status: "refused", reason: "target-reconnecting", attempt: 3, maxAttempts: 8 });
  });

  it("refuses a connected target that holds no attestation yet, remembered Full access included", () => {
    for (const posture of [...CONFINED_POSTURES, "full-access"] as const) {
      const { attestation: _attestation, ...withoutAttestation } = request({
        posture,
        permissionPersistence: "project-default",
      });
      expect(decideSshAdmission(withoutAttestation)).toEqual({
        status: "refused",
        reason: "not-attested",
        posture,
      });
    }
  });

  it("refuses Full access unless it is remembered for the Project", () => {
    for (const subject of OCTANT_SUBJECTS) {
      expect(
        decideSshAdmission(
          request({ posture: "full-access", permissionPersistence: "current-session", subject }),
        ),
      ).toEqual({ status: "refused", reason: "full-access-not-remembered" });
    }
  });

  it("admits remembered Full access on the executor's identity and platform facts alone", () => {
    const facts = linuxFacts({ backend: { kind: "none" }, canaries: [] });
    for (const subject of OCTANT_SUBJECTS) {
      expect(
        decideSshAdmission(
          request({
            attestation: attested(facts),
            posture: "full-access",
            permissionPersistence: "project-default",
            subject,
          }),
        ),
      ).toEqual({ status: "admitted" });
    }
  });

  it("still refuses remembered Full access for a mismatched executor, an unsupported platform, or root", () => {
    const fullAccess = {
      posture: "full-access",
      permissionPersistence: "project-default",
    } as const;
    expect(
      decideSshAdmission(
        request({
          ...fullAccess,
          attestation: attested(
            linuxFacts({
              identity: { buildVersion: "0.8.9", protocolVersion: 1, installVerified: true },
            }),
          ),
        }),
      ),
    ).toEqual({ status: "refused", reason: "executor-version-mismatch" });
    expect(
      decideSshAdmission(
        request({
          ...fullAccess,
          attestation: attested(
            linuxFacts({ platform: { operatingSystem: "win32", architecture: "x64", uid: 1000 } }),
          ),
        }),
      ),
    ).toEqual({ status: "refused", reason: "unsupported-platform" });
    expect(
      decideSshAdmission(
        request({
          ...fullAccess,
          attestation: attested(
            macosFacts({ platform: { operatingSystem: "darwin", architecture: "arm64", uid: 0 } }),
          ),
        }),
      ),
    ).toEqual({ status: "refused", reason: "remote-root-user" });
    expect(
      decideSshAdmission(request({ ...fullAccess, connection: { state: "unreachable" } })),
    ).toEqual({
      status: "refused",
      reason: "target-unreachable",
    });
  });

  it("refuses a provider runtime that rests on its own sandbox in every posture", () => {
    const ownSandbox: SshAdmissionSubject = {
      kind: "provider-runtime",
      octantWrapsInPosture: false,
      remotePlacement: "declared",
      appToolTransportListensOnLoopback: false,
    };
    for (const posture of [...CONFINED_POSTURES, "full-access"] as const) {
      expect(
        decideSshAdmission(
          request({ posture, permissionPersistence: "project-default", subject: ownSandbox }),
        ),
      ).toEqual({ status: "refused", reason: "runtime-not-attestable" });
    }
  });

  it("admits a runtime Octant wraps only when its driver declares remote placement and it opens no loopback tool listener", () => {
    const wrapped = {
      kind: "provider-runtime",
      octantWrapsInPosture: true,
      remotePlacement: "declared",
      appToolTransportListensOnLoopback: false,
    } as const;
    for (const posture of CONFINED_POSTURES) {
      expect(decideSshAdmission(request({ posture, subject: wrapped }))).toEqual({
        status: "admitted",
      });
      expect(
        decideSshAdmission(
          request({ posture, subject: { ...wrapped, remotePlacement: "undeclared" } }),
        ),
      ).toEqual({ status: "refused", reason: "runtime-not-attestable" });
      expect(
        decideSshAdmission(
          request({ posture, subject: { ...wrapped, appToolTransportListensOnLoopback: true } }),
        ),
      ).toEqual({ status: "refused", reason: "runtime-not-attestable" });
    }
  });

  it("refuses every provider runtime under Full access, where Octant wraps none", () => {
    const wrapped = {
      kind: "provider-runtime",
      octantWrapsInPosture: true,
      remotePlacement: "declared",
      appToolTransportListensOnLoopback: false,
    } as const;
    expect(
      decideSshAdmission(
        request({
          posture: "full-access",
          permissionPersistence: "project-default",
          subject: wrapped,
        }),
      ),
    ).toEqual({ status: "refused", reason: "runtime-not-attestable" });
  });

  it("refuses a placed runtime in a posture whose runtime canaries did not all report a refusal, while still admitting commands there", () => {
    const wrapped = {
      kind: "provider-runtime",
      octantWrapsInPosture: true,
      remotePlacement: "declared",
      appToolTransportListensOnLoopback: false,
    } as const;
    expect(SSH_RUNTIME_CANARY_PROBES_BY_POSTURE).toEqual({
      plan: [
        "runtime-write-inside-root",
        "runtime-write-read-only-account-state",
        "runtime-exec-after-start",
        "runtime-fork-after-start",
        "runtime-read-ssh-directory",
        "runtime-read-other-runtime-home",
        "runtime-connect-bypassing-proxy",
      ],
      "approval-gated": [
        "runtime-write-outside-root-and-home",
        "runtime-write-read-only-account-state",
        "runtime-read-ssh-directory",
        "runtime-read-other-runtime-home",
        "runtime-connect-bypassing-proxy",
      ],
      "auto-accept-edits": [
        "runtime-write-outside-root-and-home",
        "runtime-write-read-only-account-state",
        "runtime-read-ssh-directory",
        "runtime-read-other-runtime-home",
        "runtime-connect-bypassing-proxy",
      ],
    });
    for (const posture of CONFINED_POSTURES) {
      for (const probe of SSH_RUNTIME_CANARY_PROBES_BY_POSTURE[posture]) {
        for (const result of ["inconclusive", "missing"] as const) {
          const facts = linuxFacts({
            canaries: canaries((entry, candidate) =>
              entry === posture && candidate === probe ? result : "refused",
            ),
          });
          expect(
            decideSshAdmission(
              request({ attestation: attested(facts), posture, subject: wrapped }),
            ),
          ).toEqual({ status: "refused", reason: "not-attested", posture, probe });
          expect(
            decideSshAdmission(
              request({
                attestation: attested(facts),
                posture,
                subject: { kind: "octant-launch" },
              }),
            ),
          ).toEqual({ status: "admitted" });
        }
      }
    }
  });

  it("refuses a placed runtime on a macOS target, whose forwarder is not settled", () => {
    const wrapped = {
      kind: "provider-runtime",
      octantWrapsInPosture: true,
      remotePlacement: "declared",
      appToolTransportListensOnLoopback: false,
    } as const;
    for (const posture of CONFINED_POSTURES) {
      expect(
        decideSshAdmission(
          request({ attestation: attested(macosFacts()), posture, subject: wrapped }),
        ),
      ).toEqual({ status: "refused", reason: "runtime-not-attestable" });
    }
  });

  it("refuses everything on a connection where a runtime canary escaped", () => {
    const facts = linuxFacts({
      canaries: canaries((posture, probe) =>
        posture === "plan" && probe === "runtime-read-ssh-directory" ? "escaped" : "refused",
      ),
    });
    expect(
      decideSshAdmission(
        request({ attestation: attested(facts), subject: { kind: "file-operation" } }),
      ),
    ).toEqual({
      status: "refused",
      reason: "confinement-canary-escaped",
      posture: "plan",
      probe: "runtime-read-ssh-directory",
    });
  });
});
