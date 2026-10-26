import { describe, expect, it } from "vitest";
import { resolveSshTargetCliCommand, runSshTargetCliCommand } from "./sshTargetCommand";
import type { LocalControlRequest, LocalControlResponse } from "./localControl";

const fingerprint = `SHA256:${"Q".repeat(43)}`;
const probe = {
  probeId: "44444444-4444-4444-8444-444444444444",
  destination: "build@devbox",
  hostKey: {
    algorithm: "ssh-ed25519",
    publicKey: "AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl",
  },
  fingerprint,
};
const status = {
  target: {
    id: "55555555-5555-4555-8555-555555555555",
    destination: "build@devbox",
    hostKey: probe.hostKey,
    executorPath: "/opt/octant/bin/octant",
  },
  fingerprint,
  connection: "connected",
  remoteUser: "build",
  platform: "linux",
  admission: [
    { posture: "plan", decision: { status: "admitted" } },
    {
      posture: "approval-gated",
      decision: { status: "refused", reason: "confinement-backend-missing" },
    },
  ],
};

function harness(ask?: (question: string) => Promise<string | undefined>) {
  const sent: LocalControlRequest[] = [];
  const out: string[] = [];
  const err: string[] = [];
  const respond = (request: LocalControlRequest): LocalControlResponse =>
    request.path === "/api/desktop/ssh-targets/host-key"
      ? { status: 200, body: probe }
      : request.path === "/api/desktop/ssh-targets"
        ? { status: 200, body: { targets: [status] } }
        : { status: 200, body: status };
  return {
    sent,
    out,
    err,
    run: (argv: readonly string[], flags: Record<string, string | boolean> = {}) => {
      const command = resolveSshTargetCliCommand(argv, flags);
      if (command === undefined) throw new Error("unresolved");
      return runSshTargetCliCommand({
        command,
        session: {
          kind: "opened",
          windowId: "11111111-1111-4111-8111-111111111111",
          send: async (request) => {
            sent.push(request);
            return respond(request);
          },
          close: async () => undefined,
        },
        stdout: { write: (chunk) => out.push(chunk) },
        stderr: { write: (chunk) => err.push(chunk) },
        ask,
      });
    },
  };
}

describe("octant ssh-target", () => {
  it("pins a host key only after the person types yes to the fingerprint it shows", async () => {
    const declined = harness(async () => "no");
    expect(
      await declined.run(["add", "build@devbox"], { executor: "/opt/octant/bin/octant" }),
    ).toBe(1);
    expect(declined.out.join("")).toContain(fingerprint);
    expect(declined.sent.map((request) => request.path)).toEqual([
      "/api/desktop/ssh-targets/host-key",
    ]);

    const accepted = harness(async () => "yes");
    await accepted.run(["add", "build@devbox"], { executor: "/opt/octant/bin/octant" });
    expect(accepted.sent.at(-1)).toMatchObject({
      path: "/api/desktop/ssh-targets/register",
      body: { probeId: probe.probeId, fingerprint, executorPath: "/opt/octant/bin/octant" },
    });
    expect(accepted.out.join("")).toContain("approval-gated: refused, confinement-backend-missing");
  });

  it("pins nothing without a terminal unless the expected fingerprint was given and matches", async () => {
    const unattended = harness();
    expect(
      await unattended.run(["add", "build@devbox"], { executor: "/opt/octant/bin/octant" }),
    ).toBe(1);
    expect(unattended.err.join("")).toContain("--fingerprint");

    const wrong = harness();
    await wrong.run(["add", "build@devbox"], {
      executor: "/opt/octant/bin/octant",
      fingerprint: `SHA256:${"R".repeat(43)}`,
    });
    const right = harness();
    await right.run(["add", "build@devbox"], {
      executor: "/opt/octant/bin/octant",
      fingerprint,
    });
    for (const run of [unattended, wrong]) {
      expect(run.sent.map((request) => request.path)).not.toContain(
        "/api/desktop/ssh-targets/register",
      );
    }
    expect(right.sent.at(-1)?.path).toBe("/api/desktop/ssh-targets/register");
  });

  it("re-pins against the target's own destination", async () => {
    const run = harness(async () => "yes");
    await run.run(["repin", status.target.id]);
    expect(run.sent.map((request) => request.path)).toEqual([
      "/api/desktop/ssh-targets",
      "/api/desktop/ssh-targets/host-key",
      "/api/desktop/ssh-targets/repin",
    ]);
    expect(run.sent[1]?.body).toEqual({ destination: "build@devbox" });
  });

  it("reads only the arguments each action takes", () => {
    expect(resolveSshTargetCliCommand([], {})).toEqual({ action: "list" });
    expect(resolveSshTargetCliCommand(["add", "devbox"], {})).toBeUndefined();
    expect(
      resolveSshTargetCliCommand(["add", "devbox"], { executor: "/o/octant", force: true }),
    ).toBeUndefined();
    expect(resolveSshTargetCliCommand(["connect"], {})).toBeUndefined();
    expect(resolveSshTargetCliCommand(["remove", "id", "extra"], {})).toBeUndefined();
  });
});
