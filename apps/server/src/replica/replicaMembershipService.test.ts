import { verify as cryptoVerify } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { CredentialStore } from "@octant/host-runtime";
import {
  REPLICA_ENTRY_FORMAT,
  decodeReplicaMembershipEntry,
  encodeReplicaEntry,
  type ReplicaInstanceId,
  type ReplicaMembershipEntry,
} from "@octant/contracts/replica-entry";
import { REPLICA_JOIN_REQUEST_TTL_MS } from "@octant/domain/replica-membership-policy";
import type { ReplicaStore } from "@octant/plugin-api/replica-store";
import {
  deriveReplicaJoinMatchingCode,
  ReplicaMembershipService,
} from "./replicaMembershipService";
import {
  ensureReplicaDeviceKey,
  makeReplicaDeviceSigner,
  type ReplicaDeviceSigningKey,
} from "./replicaDeviceKeyService";

function memoryCredentialStore(): CredentialStore & { readonly values: Map<string, string> } {
  const values = new Map<string, string>();
  return {
    values,
    async set(id, credential) {
      values.set(id, credential);
    },
    async has(id) {
      return values.has(id);
    },
    async resolve(id) {
      const value = values.get(id);
      if (value === undefined) throw new Error("missing");
      return value;
    },
    async delete(id) {
      values.delete(id);
    },
  };
}

/** Write-once in-memory store: putIfAbsent never replaces. */
function memoryStore(): ReplicaStore & {
  readonly files: Map<string, Uint8Array>;
  readonly reads: ReadonlyArray<string>;
} {
  const files = new Map<string, Uint8Array>();
  const reads: string[] = [];
  return {
    files,
    reads,
    kind: "replica-store",
    async status() {
      return "ready";
    },
    async list() {
      return {
        status: "ready",
        entries: [...files.keys()].map((key) => ({ key })),
        reports: [],
      };
    },
    async get(key: string) {
      reads.push(key);
      const bytes = files.get(key);
      if (bytes === undefined) return { status: "missing" as const };
      return { status: "ready" as const, bytes };
    },
    async putIfAbsent(key: string, bytes: Uint8Array) {
      if (files.has(key)) return { status: "already-exists" as const };
      files.set(key, bytes);
      return { status: "stored" as const };
    },
  };
}

const ids = {
  local: "11111111-1111-4111-8111-111111111111" as ReplicaInstanceId,
  joiner: "22222222-2222-4222-8222-222222222222" as ReplicaInstanceId,
} as const;

interface Harness {
  readonly service: ReplicaMembershipService;
  readonly store: ReturnType<typeof memoryStore>;
  readonly credentials: ReturnType<typeof memoryCredentialStore>;
  readonly journal: ReadonlyArray<{ readonly eventName: string; readonly payload: unknown }>;
  readonly facts: () => {
    readonly localInstanceId: ReplicaInstanceId;
    readonly members: ReadonlyArray<{
      readonly instanceId: ReplicaInstanceId;
      readonly displayName: string;
      readonly publicKey: string;
    }>;
    readonly revocations: ReadonlyArray<ReplicaInstanceId>;
  };
}

function harness(
  initialMembers: Harness["facts"] extends () => infer F ? F : never = {
    localInstanceId: ids.local,
    members: [],
    revocations: [],
  },
  now: () => number = () => 0,
): Harness {
  const store = memoryStore();
  const credentials = memoryCredentialStore();
  const journal: { eventName: string; payload: unknown }[] = [];
  let members = [...initialMembers.members];
  const revocations = [...initialMembers.revocations];
  const service = new ReplicaMembershipService({
    store,
    credentials: {
      ensure: (instanceId) => ensureReplicaDeviceKey(credentials, instanceId),
      sign: async (instanceId, payload) =>
        makeReplicaDeviceSigner(credentials, instanceId).sign(payload),
    },
    journal: {
      append: (event) => {
        journal.push({ eventName: event.eventName, payload: event.payload });
      },
    },
    facts: () => ({
      localInstanceId: initialMembers.localInstanceId,
      members,
      revocations,
    }),
    nextSequence: () => members.length + revocations.length + 1,
    clock: now,
  });
  return {
    service,
    store,
    credentials,
    journal,
    facts: () => ({ localInstanceId: initialMembers.localInstanceId, members, revocations }),
  };
}

function joinRequest(options: {
  readonly instanceId: ReplicaInstanceId;
  readonly displayName: string;
  readonly sequence?: number;
  readonly publicKey: string;
  readonly requestedAt?: number;
}): ReplicaMembershipEntry {
  return decodeReplicaMembershipEntry({
    format: REPLICA_ENTRY_FORMAT,
    kind: "join-request",
    origin: {
      instanceId: options.instanceId,
      displayName: options.displayName,
      sequence: options.sequence ?? 1,
    },
    subject: options.instanceId,
    subjectDisplayName: options.displayName,
    subjectDeviceKey: options.publicKey,
    requestedAt: options.requestedAt ?? 0,
  });
}

/** A join request the joiner signed and wrote into the store itself. */
async function writtenJoinRequest(
  h: Harness,
  options: {
    readonly instanceId: ReplicaInstanceId;
    readonly displayName: string;
    readonly sequence?: number;
    readonly requestedAt?: number;
  },
): Promise<ReplicaMembershipEntry> {
  const key = await ensureReplicaDeviceKey(h.credentials, options.instanceId);
  const request = joinRequest({
    instanceId: options.instanceId,
    displayName: options.displayName,
    sequence: options.sequence ?? 1,
    publicKey: key.publicKey,
    requestedAt: options.requestedAt ?? 0,
  });
  const sequence = options.sequence ?? 1;
  const entryPath = `${String(options.instanceId)}/${sequence}.json`;
  const signaturePath = `${String(options.instanceId)}/${sequence}.sig`;
  const encoded = new TextEncoder().encode(encodeReplicaEntry(request));
  h.store.files.set(entryPath, encoded);
  const signer = makeReplicaDeviceSigner(h.credentials, options.instanceId);
  const { signature } = await signer.sign(encoded);
  h.store.files.set(signaturePath, new TextEncoder().encode(signature));
  return request;
}

describe("replica membership service", () => {
  it("creates a replica by writing a signed founding self-approval", async () => {
    const h = harness();
    const outcome = await h.service.execute({
      kind: "create-replica",
      displayName: "MacBook",
    });
    expect(outcome.kind).toBe("replica-created");
    if (outcome.kind !== "replica-created") throw new Error("expected replica-created");
    const encoded = encodeReplicaEntry(outcome.entry);
    const entryBytes = new TextEncoder().encode(encoded);
    const stored = await h.store.get(`${outcome.instanceId}/1.json`);
    expect(stored.status).toBe("ready");
    // The signature beside it verifies against the created device key.
    const key: ReplicaDeviceSigningKey = await ensureReplicaDeviceKey(
      h.credentials,
      outcome.instanceId,
    );
    const signatureBytes = await h.store.get(`${outcome.instanceId}/1.sig`);
    expect(signatureBytes.status).toBe("ready");
    const signatureText =
      signatureBytes.status === "ready" ? new TextDecoder().decode(signatureBytes.bytes) : "";
    const verified = verifySignature(key.publicKey, entryBytes, signatureText);
    expect(verified).toBe(true);
  });

  it("refuses an approval when the matching codes do not agree", async () => {
    const h = harness();
    const request = await writtenJoinRequest(h, {
      instanceId: ids.joiner,
      displayName: "Mac mini",
    });
    const outcome = await h.service.execute({
      kind: "approve-join",
      joinRequest: request,
      confirmationCode: "000000",
    });
    expect(outcome).toMatchObject({ kind: "refused", reason: "code-mismatch" });
    expect(h.store.files.size).toBe(2);
  });

  it("refuses an approval for a join request that is not in the store", async () => {
    const h = harness();
    const joinerKey = await ensureReplicaDeviceKey(h.credentials, ids.joiner);
    const request = joinRequest({
      instanceId: ids.joiner,
      displayName: "Mac mini",
      publicKey: joinerKey.publicKey,
    });
    const code = deriveReplicaJoinMatchingCode({
      joinRequest: request,
      approverInstanceId: ids.local,
    });
    const outcome = await h.service.execute({
      kind: "approve-join",
      joinRequest: request,
      confirmationCode: code,
    });
    expect(outcome).toMatchObject({ kind: "refused", reason: "unknown-instance" });
    expect(h.journal.some((e) => e.eventName === "replica.join-approval-refused@1")).toBe(true);
    expect(h.store.files.size).toBe(0);
  });

  it("refuses an approval whose stored join request was not signed by the joiner", async () => {
    const h = harness();
    const joinerKey = await ensureReplicaDeviceKey(h.credentials, ids.joiner);
    const request = joinRequest({
      instanceId: ids.joiner,
      displayName: "Mac mini",
      publicKey: joinerKey.publicKey,
    });
    // The caller's copy names the joiner's key, but the store holds bytes
    // someone else signed with a different key.
    const entryPath = `${String(ids.joiner)}/1.json`;
    const signaturePath = `${String(ids.joiner)}/1.sig`;
    const encoded = new TextEncoder().encode(encodeReplicaEntry(request));
    h.store.files.set(entryPath, encoded);
    await ensureReplicaDeviceKey(h.credentials, ids.local);
    const { signature } = await makeReplicaDeviceSigner(h.credentials, ids.local).sign(encoded);
    h.store.files.set(signaturePath, new TextEncoder().encode(signature));
    const code = deriveReplicaJoinMatchingCode({
      joinRequest: request,
      approverInstanceId: ids.local,
    });
    const outcome = await h.service.execute({
      kind: "approve-join",
      joinRequest: request,
      confirmationCode: code,
    });
    expect(outcome).toMatchObject({ kind: "refused", reason: "code-mismatch" });
    expect(h.store.files.size).toBe(2);
  });

  it("refuses an approval whose join request is no longer fresh", async () => {
    let now = 1_000_000;
    const h = harness(undefined, () => now);
    const request = await writtenJoinRequest(h, {
      instanceId: ids.joiner,
      displayName: "Mac mini",
      requestedAt: now,
    });
    now += REPLICA_JOIN_REQUEST_TTL_MS + 1;
    const code = deriveReplicaJoinMatchingCode({
      joinRequest: request,
      approverInstanceId: ids.local,
    });
    const outcome = await h.service.execute({
      kind: "approve-join",
      joinRequest: request,
      confirmationCode: code,
    });
    expect(outcome).toMatchObject({ kind: "refused", reason: "expired-join-request" });
    expect(h.journal.some((e) => e.eventName === "replica.join-approval-refused@1")).toBe(true);
    expect(h.store.files.size).toBe(2);
  });

  it("approves a join request after the codes agree and journals the member", async () => {
    const now = 1_000_000;
    const h = harness(undefined, () => now);
    await ensureReplicaDeviceKey(h.credentials, ids.local);
    const request = await writtenJoinRequest(h, {
      instanceId: ids.joiner,
      displayName: "Mac mini",
      requestedAt: now,
    });
    const code = deriveReplicaJoinMatchingCode({
      joinRequest: request,
      approverInstanceId: ids.local,
    });
    const outcome = await h.service.execute({
      kind: "approve-join",
      joinRequest: request,
      confirmationCode: code,
    });
    expect(outcome.kind).toBe("join-approved");
    expect(h.journal.some((e) => e.eventName === "replica.join-approved@1")).toBe(true);
  });

  it("writes a join request the approver can read back from the store", async () => {
    const now = 1_800_000_000_000;
    const h = harness(undefined, () => now);
    const outcome = await h.service.execute({
      kind: "write-join-request",
      displayName: "Mac mini",
    });
    expect(outcome.kind).toBe("join-requested");
    if (outcome.kind !== "join-requested") throw new Error("expected join-requested");
    expect(outcome.entry.requestedAt).toBe(now);
    expect(h.store.files.size).toBe(2);
  });

  it("leaves no entry behind when the signature publish fails", async () => {
    const h = harness();
    const files = h.store.files;
    // One entry already holds the next sequence, so the write-once store
    // refuses the new entry's publish.
    files.set("11111111-1111-4111-8111-111111111111/1.sig", new TextEncoder().encode("taken"));
    const outcome = await h.service.execute({
      kind: "write-join-request",
      displayName: "Mac mini",
    });
    expect(outcome.kind).toBe("store-failed");
    expect(files.has("11111111-1111-4111-8111-111111111111/1.json")).toBe(false);
    const failure = h.journal.find(
      (event) => event.eventName === "replica.membership-store-failure@1",
    );
    expect(failure?.payload).toMatchObject({ kind: "store-failure", phase: "signature" });
  });

  it("refuses to revoke a computer that is not a member", async () => {
    const h = harness();
    const outcome = await h.service.execute({ kind: "revoke", subject: ids.joiner });
    expect(outcome).toMatchObject({ kind: "refused", reason: "unknown-instance" });
    expect(h.store.files.size).toBe(0);
  });

  it("publishes a revocation for a member", async () => {
    const joinerKey = await ensureReplicaDeviceKey(memoryCredentialStore(), ids.joiner);
    const h = harness({
      localInstanceId: ids.local,
      members: [
        { instanceId: ids.local, displayName: "MacBook", publicKey: "pub-local" },
        { instanceId: ids.joiner, displayName: "Mac mini", publicKey: joinerKey.publicKey },
      ],
      revocations: [],
    });
    await ensureReplicaDeviceKey(h.credentials, ids.local);
    const outcome = await h.service.execute({ kind: "revoke", subject: ids.joiner });
    expect(outcome.kind).toBe("revoked");
    if (outcome.kind !== "revoked") throw new Error("expected revoked");
    const stored = await h.store.get(`${ids.local}/3.json`);
    expect(stored.status).toBe("ready");
  });
});

function verifySignature(
  publicKeyBase64: string,
  payload: Uint8Array,
  signatureBase64: string,
): boolean {
  try {
    return cryptoVerify(
      null,
      Buffer.from(payload),
      {
        key: Buffer.from(publicKeyBase64, "base64"),
        format: "der",
        type: "spki",
      },
      Buffer.from(signatureBase64, "base64"),
    );
  } catch {
    return false;
  }
}
