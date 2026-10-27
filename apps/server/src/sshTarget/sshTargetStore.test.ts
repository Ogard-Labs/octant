import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Schema } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { decodeProviderInstanceId } from "@octant/contracts";
import { decodeUtcTimestamp } from "@octant/contracts/events";
import { decodeCodeTerminalId } from "@octant/contracts/code";
import { decodeProjectId } from "@octant/contracts/projects";
import { decodeWindowId } from "@octant/contracts/shell";
import { SshRemoteWorktreeId } from "@octant/contracts/ssh-remote-project";
import {
  SshConnectionId,
  SshDestination,
  SshExecutorPath,
  SshRemotePath,
  SshTargetId,
  type SshAttestation,
  type SshTarget,
} from "@octant/contracts/ssh-target";
import { readJournalGrowth } from "../persistence/journalGrowth";
import { rebuildProjection } from "../persistence/projection";
import { createPhase1RuntimeRegistries } from "../persistence/runtimeRegistry";
import { readSshRemoteProjects, readSshTargets } from "../persistence/sshTargetProjection";
import { sshAttestationFactsDigest } from "./sshTargetStore";
import { openSshTargetTestStore } from "./sshTargetStore.test-support";

const FIRST_KEY = "AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl";
const SECOND_KEY = "AAAAC3NzaC1lZDI1NTE5AAAAIBn7CZ2c1sQ1y5nC0Jm6Lr9pZq3yX8bV4wQe2rT6uH0a";

const target = (id: string, destination: string): SshTarget => ({
  id: Schema.decodeUnknownSync(SshTargetId)(id),
  destination: Schema.decodeUnknownSync(SshDestination)(destination),
  hostKey: { algorithm: "ssh-ed25519", publicKey: FIRST_KEY },
  executorPath: Schema.decodeUnknownSync(SshExecutorPath)("/opt/octant-private/bin/octant"),
});

const devbox = target("11111111-1111-4111-8111-111111111111", "build@devbox.internal");
const agentPath = Schema.decodeUnknownSync(SshRemotePath);
const firstInstance = decodeProviderInstanceId("99999999-9999-4999-8999-999999999991");
const secondInstance = decodeProviderInstanceId("99999999-9999-4999-8999-999999999992");
const spare = target("22222222-2222-4222-8222-222222222222", "spare.internal");

const attestation: SshAttestation = {
  connectionId: Schema.decodeUnknownSync(SshConnectionId)("33333333-3333-4333-8333-333333333333"),
  facts: {
    identity: { buildVersion: "0.9.0", protocolVersion: 1, installVerified: true },
    platform: { operatingSystem: "linux", architecture: "x64", uid: 1000 },
    backend: { kind: "none" },
    canaries: [],
  },
};

const project = {
  id: decodeProjectId("44444444-4444-4444-8444-444444444444"),
  name: "App",
  targetId: devbox.id,
  remoteRoot: Schema.decodeUnknownSync(SshRemotePath)("/home/build/private-app"),
  boundAt: decodeUtcTimestamp("2026-10-26T10:00:00.000Z"),
};

let directory: string;
let opened: ReturnType<typeof openSshTargetTestStore>;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "octant-ssh-store-"));
  opened = openSshTargetTestStore(directory);
});

afterEach(() => {
  opened.connection.close();
  rmSync(directory, { recursive: true, force: true });
});

describe("SSH target journal", () => {
  it("replays registration, re-pin, attestation, runtime paths, binding, and removal to the same targets and Projects", () => {
    const { store, connection, journal } = opened;
    expect(store.register(devbox)).toBe("recorded");
    expect(store.register(spare)).toBe("recorded");
    expect(store.repin(devbox.id, { algorithm: "ssh-ed25519", publicKey: SECOND_KEY })).toBe(
      "recorded",
    );
    expect(
      store.recordAttestation(devbox.id, attestation, [
        { posture: "plan", decision: { status: "refused", reason: "confinement-backend-missing" } },
      ]),
    ).toBe("recorded");
    expect(store.bindProject(project)).toBe("recorded");
    // A binding never changes: a second one under the same id is refused.
    expect(store.bindProject({ ...project, targetId: spare.id })).toBe("refused");
    // One path per provider instance, the latest replacing the earlier; a
    // removed target's paths go with it.
    expect(
      store.setRuntimeBinary(devbox.id, firstInstance, agentPath("/opt/agent/bin/agent")),
    ).toBe("recorded");
    expect(
      store.setRuntimeBinary(devbox.id, secondInstance, agentPath("/opt/other/bin/agent")),
    ).toBe("recorded");
    expect(
      store.setRuntimeBinary(devbox.id, firstInstance, agentPath("/opt/agent-2/bin/agent")),
    ).toBe("recorded");
    expect(store.setRuntimeBinary(spare.id, firstInstance, agentPath("/opt/agent/bin/agent"))).toBe(
      "recorded",
    );
    expect(store.remove(spare.id)).toBe("recorded");

    const expectState = () => {
      expect(store.list()).toEqual([
        { ...devbox, hostKey: { algorithm: "ssh-ed25519", publicKey: SECOND_KEY } },
      ]);
      expect(store.get(spare.id)).toBeUndefined();
      expect(readSshTargets(connection)[0]?.lastAttestation?.attested).toEqual({
        targetId: devbox.id,
        connectionId: attestation.connectionId,
        factsDigest: sshAttestationFactsDigest(attestation.facts),
        admission: [
          {
            posture: "plan",
            decision: { status: "refused", reason: "confinement-backend-missing" },
          },
        ],
      });
      expect(readSshRemoteProjects(connection)).toEqual([project]);
      expect(store.runtimeBinaries(devbox.id)).toEqual([
        { providerInstanceId: secondInstance, path: "/opt/other/bin/agent" },
        { providerInstanceId: firstInstance, path: "/opt/agent-2/bin/agent" },
      ]);
      expect(store.runtimeBinaries(spare.id)).toEqual([]);
    };
    expectState();

    const projection = createPhase1RuntimeRegistries().projections.get("ssh-targets");
    if (projection === undefined) throw new Error("the SSH target projection is not registered");
    rebuildProjection({ connection, journal, projection, clock: () => new Date().toISOString() });
    expectState();
  });

  it("replays managed worktrees and remote terminals, ending each terminal once", () => {
    const { store, connection, journal } = opened;
    store.register(devbox);
    store.bindProject(project);
    const worktree = {
      id: Schema.decodeUnknownSync(SshRemoteWorktreeId)("55555555-5555-4555-8555-555555555555"),
      projectId: project.id,
      name: "feature",
      branch: "octant/feature",
      path: Schema.decodeUnknownSync(SshRemotePath)(
        "/home/build/.octant-worktrees/44444444-4444-4444-8444-444444444444/feature",
      ),
      createdAt: decodeUtcTimestamp("2026-10-26T11:00:00.000Z"),
    };
    const removed = {
      ...worktree,
      id: Schema.decodeUnknownSync(SshRemoteWorktreeId)("66666666-6666-4666-8666-666666666666"),
      name: "old",
      branch: "octant/old",
    };
    expect(store.recordWorktreeCreated(worktree, attestation.connectionId)).toBe("recorded");
    expect(store.recordWorktreeCreated(removed, attestation.connectionId)).toBe("recorded");
    // A worktree is created once.
    expect(store.recordWorktreeCreated(worktree, attestation.connectionId)).toBe("refused");
    expect(store.recordWorktreeRemoved(removed.id, attestation.connectionId)).toBe("recorded");

    const started = (terminalId: string) => ({
      terminalId: decodeCodeTerminalId(terminalId),
      projectId: project.id,
      windowId: decodeWindowId("77777777-7777-4777-8777-777777777777"),
      targetId: devbox.id,
      connectionId: attestation.connectionId,
      posture: "approval-gated" as const,
    });
    const ended = started("88888888-8888-4888-8888-888888888881");
    const running = { ...started("88888888-8888-4888-8888-888888888882"), worktreeId: worktree.id };
    expect(store.recordTerminalStarted(ended)).toBe("recorded");
    expect(store.recordTerminalStarted(running)).toBe("recorded");
    expect(
      store.recordTerminalEnded({ terminalId: ended.terminalId, reason: "target-disconnected" }),
    ).toBe("recorded");
    expect(store.recordTerminalEnded({ terminalId: ended.terminalId, reason: "stopped" })).toBe(
      "refused",
    );

    const expectState = () => {
      expect(store.listWorktrees()).toEqual([worktree]);
      expect(store.getWorktree(removed.id)).toBeUndefined();
      expect(store.runningTerminals()).toEqual([running.terminalId]);
    };
    expectState();
    const projection = createPhase1RuntimeRegistries().projections.get("ssh-targets");
    if (projection === undefined) throw new Error("the SSH target projection is not registered");
    rebuildProjection({ connection, journal, projection, clock: () => new Date().toISOString() });
    expectState();
  });

  it("writes the pin from the journaled key alone, owner-only, for every name", () => {
    const { store } = opened;
    store.register(devbox);
    store.repin(devbox.id, { algorithm: "ssh-ed25519", publicKey: SECOND_KEY });
    const current = store.get(devbox.id);
    if (current === undefined) throw new Error("target missing");
    const pin = store.writePin(current);
    expect(readFileSync(pin, "utf8")).toBe(`* ssh-ed25519 ${SECOND_KEY}\n`);
    expect(statSync(pin).mode & 0o777).toBe(0o600);
    store.remove(devbox.id);
    expect(() => statSync(pin)).toThrow();
  });

  it("exports targets without their destination, host key, executor path, runtime paths, or remote roots", () => {
    const { store } = opened;
    store.register(devbox);
    store.setRuntimeBinary(devbox.id, firstInstance, agentPath("/opt/agent-private/bin/agent"));
    store.recordAttestation(devbox.id, attestation, [
      { posture: "plan", decision: { status: "admitted" } },
    ]);
    store.bindProject(project);
    const exported = store.exportTargets();
    expect(exported).toEqual([
      {
        targetId: devbox.id,
        registeredAt: expect.any(String),
        projectIds: [project.id],
        lastAttestation: {
          attestedAt: expect.any(String),
          factsDigest: sshAttestationFactsDigest(attestation.facts),
          admission: [{ posture: "plan", decision: { status: "admitted" } }],
        },
      },
    ]);
    const serialized = JSON.stringify(exported);
    for (const secret of [
      "devbox.internal",
      "build@",
      FIRST_KEY,
      "SHA256:",
      "/opt/octant-private",
      "/opt/agent-private",
      "/home/build/private-app",
    ]) {
      expect(serialized).not.toContain(secret);
    }
  });

  it("shows diagnostics only how many target and binding events the journal holds", () => {
    const { store, connection } = opened;
    store.register(devbox);
    store.bindProject(project);
    const growth = readJournalGrowth(connection, new Date());
    expect(growth.kinds.map((kind) => [kind.kind, kind.total])).toEqual(
      expect.arrayContaining([
        ["ssh-target", 1],
        ["ssh-remote-project", 1],
      ]),
    );
    const serialized = JSON.stringify(growth);
    for (const secret of ["devbox.internal", FIRST_KEY, "/home/build/private-app"]) {
      expect(serialized).not.toContain(secret);
    }
  });
});
