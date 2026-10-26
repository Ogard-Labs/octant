import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Schema } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { decodeUtcTimestamp } from "@octant/contracts/events";
import { decodeProjectId } from "@octant/contracts/projects";
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
  it("replays registration, re-pin, attestation, binding, and removal to the same targets and Projects", () => {
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

  it("exports targets without their destination, host key, executor path, or remote roots", () => {
    const { store } = opened;
    store.register(devbox);
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
