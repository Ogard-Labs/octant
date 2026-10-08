/**
 * Convergence fuzz harness for replica membership.
 *
 * Part one drives the real membership service and projection. It simulates
 * three to six computers that share one store but see it through sync lag:
 * each file reaches each computer at a random later step, and listings come
 * back shuffled. An honest founder brings members in, computers pull at
 * random times, members revoke, a stolen key writes revocations and
 * approvals (including a ghost identity), and revoked computers rejoin as new
 * identities. When the scenario ends, every file reaches every computer,
 * each honest computer pulls until nothing changes, and a late computer
 * joins and pulls everything; every honest computer that is not a member
 * by then joins again through the founder. The properties are then checked
 * against the ground truth the harness recorded - who confirmed which
 * approver, and which key belongs to which identity - and against the valid
 * records in the store, checked here independently of the host's read path.
 * Progress is a property too: an honest join through an approver in good
 * standing succeeds, and every honest computer ends up reading as a member.
 *
 * Part two runs the same properties, plus a blast-radius check, directly
 * against the domain derivation over many more abstract worlds: folder-store
 * rewrites (two records in one slot), ghosts, records filed under another
 * computer's id with the attacker's own key, approvals naming the wrong key,
 * and second accepts, with each reader holding a random subset, the same
 * subset shuffled with duplicates, and the full set.
 *
 * Seeds are reproducible: ids, keys, steps, and lag all come from the seed.
 * OCTANT_REPLICA_FUZZ_SEEDS sets how many seeds run (default 40).
 */

import { createHash, createPrivateKey, createPublicKey } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { CredentialStore } from "@octant/host-runtime";
import {
  LOCAL_HOST_ID,
  REPLICA_ENTRY_FORMAT,
  decodeReplicaEntryText,
  decodeReplicaMembershipEntry,
  encodeReplicaEntry,
  type ReplicaInstanceId,
  type ReplicaMembershipEntry,
  type ReplicaMembershipResult,
} from "@octant/contracts";
import {
  deriveReplicaMembership,
  replicaInGoodStanding,
  type ReplicaHeldRecord,
} from "@octant/domain/replica-membership-policy";
import type { ReplicaStore, ReplicaStorePutResult } from "@octant/plugin-api/replica-store";
import { AggregateHeadsProjection } from "../persistence/aggregateHeadsProjection";
import { EventRegistry } from "../persistence/eventRegistry";
import { Journal } from "../persistence/journal";
import { applyMigrations, MIGRATIONS } from "../persistence/migrations";
import { ProjectionRegistry } from "../persistence/projection";
import { openSqlite } from "../persistence/sqlitePort";
import {
  makeReplicaDeviceSigner,
  replicaInstanceIdOf,
  verifyReplicaEntrySignature,
} from "./replicaDeviceKeyService";
import {
  createReplicaMembershipJournal,
  registerReplicaMembershipEvents,
  ReplicaMembershipProjection,
} from "./replicaMembershipProjection";
import {
  deriveReplicaJoinMatchingCode,
  ReplicaMembershipService,
} from "./replicaMembershipService";

const NOW_ISO = "2026-10-07T10:00:00.000Z";
const NOW = Date.parse(NOW_ISO);
const SEEDS = Number(process.env.OCTANT_REPLICA_FUZZ_SEEDS ?? "40");
const MAX_LAG = 6;

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

type Rng = () => number;

function rngFor(seed: number): Rng {
  let state = (seed * 0x9e3779b9) >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32;
  };
}

function pick<T>(rng: Rng, values: ReadonlyArray<T>): T | undefined {
  return values[Math.floor(rng() * values.length)];
}

function shuffled<T>(rng: Rng, values: ReadonlyArray<T>): T[] {
  const result = [...values];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const other = Math.floor(rng() * (index + 1));
    const here = result[index];
    const there = result[other];
    if (here === undefined || there === undefined) continue;
    result[index] = there;
    result[other] = here;
  }
  return result;
}

const PKCS8_ED25519_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

/**
 * A device key from the seed, stored under the id it certifies, so a seed
 * replays with the same ids and keys.
 */
async function seededKey(
  rng: Rng,
  credentials: CredentialStore,
): Promise<{ readonly instanceId: string; readonly publicKey: string }> {
  const seed = Buffer.from(Array.from({ length: 32 }, () => Math.floor(rng() * 256)));
  const privateKey = createPrivateKey({
    key: Buffer.concat([PKCS8_ED25519_PREFIX, seed]),
    format: "der",
    type: "pkcs8",
  });
  const pem = String(privateKey.export({ format: "pem", type: "pkcs8" }));
  const publicKey = createPublicKey(pem).export({ format: "der", type: "spki" }).toString("base64");
  const instanceId = replicaInstanceIdOf(publicKey);
  await credentials.set(instanceId, pem);
  return { instanceId, publicKey };
}

interface Violation {
  readonly property: Property;
  readonly seed: number;
  readonly detail: string;
}

type Property =
  | "P1 convergence"
  | "P2 precedence"
  | "P3 key binding"
  | "P4 no new ancestors"
  | "P5 progress";

const DERIVATION_PROPERTIES: ReadonlyArray<Property> = [
  "P1 convergence",
  "P2 precedence",
  "P3 key binding",
  "P4 no new ancestors",
];
/** Progress needs real commands, so only the service half checks it. */
const SERVICE_PROPERTIES: ReadonlyArray<Property> = [...DERIVATION_PROPERTIES, "P5 progress"];

/** Ground truth the harness records as the scenario runs. */
interface Truth {
  /** Each identity's real device key. */
  readonly key: Map<string, string>;
  /** The approver each identity confirmed (a ghost's is the stolen key that approved it). */
  readonly parent: Map<string, string>;
}

function isTrueDescendant(truth: Truth, node: string, ancestor: string): boolean {
  const seen = new Set<string>();
  let current = truth.parent.get(node);
  while (current !== undefined && !seen.has(current)) {
    if (current === ancestor) return true;
    seen.add(current);
    current = truth.parent.get(current);
  }
  return false;
}

function summarize(violations: ReadonlyArray<Violation>, property: Property, runs: number): string {
  const mine = violations.filter((violation) => violation.property === property);
  const seeds = [...new Set(mine.map((violation) => violation.seed))].sort((a, b) => a - b);
  const kinds = new Map<string, Set<number>>();
  for (const violation of mine) {
    const kind = /^\[([^\]]+)\]/.exec(violation.detail)?.[1] ?? "all";
    kinds.set(kind, (kinds.get(kind) ?? new Set()).add(violation.seed));
  }
  const byKind = [...kinds.entries()]
    .map(
      ([kind, found]) =>
        `  ${kind}: ${found.size} seeds, first ${[...found].slice(0, 8).join(", ")}`,
    )
    .join("\n");
  const examples = mine
    .slice(0, 4)
    .map((violation) => `  seed ${violation.seed}: ${violation.detail}`)
    .join("\n");
  return `${property}: ${seeds.length}/${runs} seeds fail\n${byKind}\n${examples}`;
}

// ---------------------------------------------------------------------------
// Part one: the current service and projection
// ---------------------------------------------------------------------------

function memoryCredentialStore(): CredentialStore {
  const values = new Map<string, string>();
  return {
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

const slotOf = (key: string) => key.replace(/\.(json|sig)$/, "");

/**
 * One write-once store seen through per-computer sync lag. A file reaches
 * its writer at once and every other reader at a random later step; a
 * reader that is revealed a slot, or the whole store, sees it from then on.
 */
class LaggedStore {
  readonly files = new Map<string, Uint8Array>();
  readonly #writtenAt = new Map<string, number>();
  readonly #visibleAt = new Map<string, Map<string, number>>();
  readonly #rng: Rng;
  step = 0;
  settled = false;

  constructor(rng: Rng) {
    this.#rng = rng;
  }

  #visibility(reader: string): Map<string, number> {
    const known = this.#visibleAt.get(reader) ?? new Map<string, number>();
    this.#visibleAt.set(reader, known);
    return known;
  }

  visible(reader: string, key: string): boolean {
    if (!this.files.has(key)) return false;
    if (this.settled) return true;
    const slot = slotOf(key);
    const visibility = this.#visibility(reader);
    let at = visibility.get(slot);
    if (at === undefined) {
      at = (this.#writtenAt.get(slot) ?? 0) + Math.floor(this.#rng() * (MAX_LAG + 1));
      visibility.set(slot, at);
    }
    return this.step >= at;
  }

  reveal(reader: string, slot: string): void {
    this.#visibility(reader).set(slot, this.step);
  }

  revealAll(reader: string): void {
    for (const key of this.files.keys()) this.reveal(reader, slotOf(key));
  }

  write(writer: string, key: string, bytes: Uint8Array): void {
    this.files.set(key, bytes);
    const slot = slotOf(key);
    if (!this.#writtenAt.has(slot)) this.#writtenAt.set(slot, this.step);
    this.#visibility(writer).set(slot, this.step);
  }

  view(reader: string): ReplicaStore {
    return {
      kind: "replica-store",
      status: async () => "ready",
      list: async () => ({
        status: "ready",
        entries: shuffled(
          this.#rng,
          [...this.files.keys()].filter((key) => this.visible(reader, key)),
        ).map((key) => ({ key })),
        reports: [],
      }),
      get: async (key: string) => {
        const bytes = this.files.get(key);
        if (bytes === undefined || !this.visible(reader, key))
          return { status: "missing" as const };
        return { status: "ready" as const, bytes };
      },
      putIfAbsent: async (key: string, bytes: Uint8Array): Promise<ReplicaStorePutResult> => {
        if (this.files.has(key)) return { status: "already-exists" };
        this.write(reader, key, bytes);
        return { status: "stored" };
      },
    };
  }

  /** Every membership record in the store, decoded, valid or not. */
  records(): ReadonlyArray<ReplicaMembershipEntry> {
    const result: ReplicaMembershipEntry[] = [];
    for (const [key, bytes] of this.files) {
      if (!key.endsWith(".json")) continue;
      let entry;
      try {
        entry = decodeReplicaEntryText(new TextDecoder().decode(bytes));
      } catch {
        continue;
      }
      if (entry.kind !== "artifact-version" && entry.kind !== "artifact-tombstone") {
        result.push(entry);
      }
    }
    return result;
  }

  /**
   * The valid membership records in the store, checked here on their own
   * rather than through the host's read path: the body decodes, its origin
   * is its path, its id is its key's id, an approval's subject is its subject
   * key's id, and the signature verifies under the key the body names.
   */
  validRecords(): ReadonlyArray<ReplicaHeldRecord> {
    const result: ReplicaHeldRecord[] = [];
    for (const [key, bytes] of this.files) {
      const match = /^([^/]+)\/(\d+)\.json$/.exec(key);
      const signature = this.files.get(key.replace(/\.json$/, ".sig"));
      if (match === null || signature === undefined) continue;
      let entry;
      try {
        entry = decodeReplicaEntryText(new TextDecoder().decode(bytes));
      } catch {
        continue;
      }
      if (entry.kind === "artifact-version" || entry.kind === "artifact-tombstone") continue;
      if (
        String(entry.origin.instanceId) !== match[1] ||
        entry.origin.sequence !== Number(match[2]) ||
        replicaInstanceIdOf(entry.origin.publicKey) !== match[1] ||
        (entry.kind === "join-approved" &&
          replicaInstanceIdOf(entry.subjectKey) !== String(entry.subject)) ||
        !verifyReplicaEntrySignature({
          publicKeyBase64: entry.origin.publicKey,
          payload: bytes,
          signatureBase64: new TextDecoder().decode(signature),
        })
      ) {
        continue;
      }
      result.push({ entry, hash: createHash("sha256").update(bytes).digest("hex") });
    }
    return result;
  }

  highestSequence(instanceId: string): number {
    let highest = 0;
    for (const key of this.files.keys()) {
      const match = /^([^/]+)\/(\d+)\.json$/.exec(key);
      if (match?.[1] === instanceId) highest = Math.max(highest, Number(match[2]));
    }
    return highest;
  }
}

const directories: string[] = [];
afterAll(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

interface Computer {
  readonly name: string;
  readonly service: ReplicaMembershipService;
  readonly projection: ReplicaMembershipProjection;
  readonly credentials: CredentialStore;
  stolen: boolean;
}

function makeComputer(store: LaggedStore, name: string, rng: Rng): Computer {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "octant-replica-convergence-")));
  directories.push(directory);
  const connection = openSqlite(join(directory, "events.sqlite3"));
  applyMigrations(connection, MIGRATIONS, () => NOW_ISO);
  const projection = new ReplicaMembershipProjection();
  const projections = new ProjectionRegistry()
    .register(new AggregateHeadsProjection())
    .register(projection);
  const journal = new Journal({
    connection,
    registry: registerReplicaMembershipEvents(new EventRegistry()),
    projections,
    clock: () => NOW_ISO,
  });
  const credentials = memoryCredentialStore();
  let uuid = 0;
  const view = store.view(name);
  const service = new ReplicaMembershipService({
    store: () => ({ status: "selected", store: view }),
    credentials: {
      create: () => seededKey(rng, credentials),
      sign: (instanceId, payload) => makeReplicaDeviceSigner(credentials, instanceId).sign(payload),
    },
    journal: createReplicaMembershipJournal({
      journal,
      uuid: () => {
        uuid += 1;
        return `00000000-0000-4000-8000-${String(uuid).padStart(12, "0")}`;
      },
      clock: () => NOW_ISO,
      actor: { kind: "local-user", actorId: "77777777-7777-4777-8777-777777777777" },
    }),
    state: () => projection.state(),
    localHostId: LOCAL_HOST_ID,
    clock: () => NOW,
  });
  return { name, service, projection, credentials, stolen: false };
}

function localId(host: Computer): string | undefined {
  const local = host.projection.state().local;
  return local === undefined ? undefined : String(local.instanceId);
}

/** Whether a computer considers itself a member in good standing. */
function believesMember(host: Computer): boolean {
  const state = host.projection.state();
  const local = state.local;
  if (local === undefined) return false;
  const id = String(local.instanceId);
  return (
    state.members.some((member) => String(member.instanceId) === id) &&
    !state.revocations.some((cut) => String(cut.instanceId) === id)
  );
}

function heldKey(record: ReplicaHeldRecord): string {
  return `${String(record.entry.origin.instanceId)}/${record.entry.origin.sequence}#${record.hash}`;
}

function reasonOf(outcome: ReplicaMembershipResult): string {
  return outcome.kind === "refused" ? `refused:${outcome.reason}` : outcome.kind;
}

interface Snapshot {
  readonly members: ReadonlyArray<string>;
  readonly cuts: ReadonlyArray<string>;
}

function snapshot(host: Computer): Snapshot {
  const state = host.projection.state();
  return {
    members: state.members
      .map(
        (member) =>
          `${String(member.instanceId).slice(0, 8)}:${member.publicKey.slice(16, 24)}<${String(member.parent).slice(0, 8)}`,
      )
      .sort(),
    cuts: state.revocations
      .map((cut) => `${String(cut.instanceId).slice(0, 8)}@${cut.lastAcceptedSequence}`)
      .sort(),
  };
}

function membershipEntry(fields: Record<string, unknown>): ReplicaMembershipEntry {
  return decodeReplicaMembershipEntry({ format: REPLICA_ENTRY_FORMAT, ...fields });
}

interface CurrentRun {
  readonly violations: ReadonlyArray<Violation>;
  readonly trace: ReadonlyArray<string>;
}

async function runCurrent(seed: number): Promise<CurrentRun> {
  const rng = rngFor(seed);
  const store = new LaggedStore(rng);
  const truth: Truth = { key: new Map(), parent: new Map() };
  const trace: string[] = [];
  const violations: Violation[] = [];
  const count = 3 + Math.floor(rng() * 4);
  const computers = Array.from({ length: count }, (_, index) =>
    makeComputer(store, `C${index}`, rng),
  );
  const [founder] = computers;
  if (founder === undefined) throw new Error("no founder");
  const created = await founder.service.execute({ kind: "create-replica", displayName: "C0" });
  if (created.kind !== "replica-created") throw new Error(`founding failed: ${reasonOf(created)}`);
  const founderId = String(created.instanceId);
  truth.key.set(founderId, created.entry.origin.publicKey);
  // Keys the thief holds: stolen computers' identities and its own ghosts.
  const stolenKeys = new Map<string, CredentialStore>();
  const ghosts = new Set<string>();
  const ghostKeys = memoryCredentialStore();
  let impersonations = 0;
  const honestRevocations: Array<{ by: string; subject: string; outcome: string }> = [];

  const honest = () => computers.filter((host) => !host.stolen);
  const membersOf = (host: Computer) =>
    host.projection.state().members.map((member) => String(member.instanceId));

  const stall = (kind: string, detail: string) =>
    violations.push({ property: "P5 progress", seed, detail: `[${kind}] ${detail}` });
  /** Whether a reader holding every valid record in the store now sees `id` in good standing. */
  const standsInStore = (id: string) =>
    replicaInGoodStanding(
      deriveReplicaMembership(founderId as ReplicaInstanceId, store.validRecords()),
      id as ReplicaInstanceId,
    );

  /**
   * An honest join. The approver believes it is a member; after it pulls,
   * its approval must succeed unless the pull showed it otherwise, and the
   * joiner's confirmation must succeed whenever the approver is in good
   * standing over everything the store holds.
   */
  async function join(joiner: Computer, approver: Computer, phase: string): Promise<void> {
    const approverId = localId(approver);
    if (approverId === undefined) return;
    const request = await joiner.service.execute({
      kind: "write-join-request",
      displayName: joiner.name,
    });
    if (request.kind !== "join-requested") {
      trace.push(`${store.step} ${joiner.name} request ${reasonOf(request)}`);
      stall(`${phase} request`, `${joiner.name} cannot ask to join: ${reasonOf(request)}`);
      return;
    }
    const joinerId = String(request.instanceId);
    truth.key.set(joinerId, request.entry.origin.publicKey);
    store.reveal(approver.name, `${joinerId}/${request.entry.origin.sequence}`);
    await approver.service.execute({ kind: "pull" });
    const state = approver.projection.state();
    if (state.local === undefined || state.founder === undefined) return;
    const code = deriveReplicaJoinMatchingCode({
      joinRequest: request.entry,
      approver: state.local,
      founder: state.founder,
    });
    const approved = await approver.service.execute({
      kind: "approve-join",
      joinRequest: request.entry,
      confirmationCode: code,
    });
    trace.push(
      `${store.step} ${approver.name} approves ${joiner.name}(${joinerId.slice(0, 8)}) ${reasonOf(approved)}`,
    );
    if (approved.kind !== "join-approved") {
      if (believesMember(approver)) {
        stall(
          `${phase} approve`,
          `${approver.name} believes it is a member but cannot approve ${joiner.name}: ${reasonOf(approved)}`,
        );
      }
      return;
    }
    store.revealAll(joiner.name);
    const approverStands = standsInStore(approverId);
    const confirmed = await joiner.service.execute({
      kind: "confirm-join",
      approver: approverId as ReplicaInstanceId,
      confirmationCode: code,
    });
    trace.push(`${store.step} ${joiner.name} confirms ${reasonOf(confirmed)}`);
    if (confirmed.kind === "join-confirmed") {
      truth.parent.set(joinerId, approverId);
    } else if (approverStands) {
      stall(
        `${phase} confirm`,
        `${joiner.name} cannot confirm ${approver.name}'s approval, which stands over the whole store: ${reasonOf(confirmed)}`,
      );
    }
  }

  /**
   * Signs and writes a record with a key the thief holds - the key of the id
   * the record is filed under unless `signer` names another; returns the
   * file's hash.
   */
  async function writeAs(
    credentials: CredentialStore,
    entry: ReplicaMembershipEntry,
    signer: string = entry.origin.instanceId,
  ): Promise<string> {
    const bytes = new TextEncoder().encode(encodeReplicaEntry(entry));
    const { signature } = await makeReplicaDeviceSigner(credentials, signer).sign(bytes);
    const path = `${entry.origin.instanceId}/${entry.origin.sequence}`;
    store.write("thief", `${path}.sig`, new TextEncoder().encode(signature));
    store.write("thief", `${path}.json`, bytes);
    return createHash("sha256").update(bytes).digest("hex");
  }

  const originOf = (id: string, sequence: number, displayName: string) => ({
    instanceId: id,
    displayName,
    sequence,
    publicKey: truth.key.get(id),
  });

  async function attack(): Promise<void> {
    const [thiefId, credentials] = pick(rng, [...stolenKeys.entries()]) ?? [];
    if (thiefId === undefined || credentials === undefined) return;
    const others = [...truth.key.keys()].filter((id) => id !== thiefId);
    const roll = rng();
    const next = (id: string) => store.highestSequence(id) + 1;
    if (roll < 0.3) {
      // Revoke an ancestor (its approver, or the founder) or anyone else.
      const target =
        rng() < 0.7 ? (truth.parent.get(thiefId) ?? founderId) : (pick(rng, others) ?? founderId);
      const cut = Math.floor(rng() * (store.highestSequence(target) + 1));
      await writeAs(
        credentials,
        membershipEntry({
          kind: "revocation",
          origin: originOf(thiefId, next(thiefId), "Thief"),
          subject: target,
          cut,
        }),
      );
      trace.push(`${store.step} thief ${thiefId.slice(0, 8)} revokes ${target.slice(0, 8)}@${cut}`);
      return;
    }
    if (roll < 0.5) {
      // A ghost: the stolen key admits a fresh identity, which accepts, then
      // approves a real member again with its real key and may revoke someone.
      const ghost = await seededKey(rng, ghostKeys);
      const ghostId = ghost.instanceId;
      truth.key.set(ghostId, ghost.publicKey);
      truth.parent.set(ghostId, thiefId);
      ghosts.add(ghostId);
      await writeAs(
        ghostKeys,
        membershipEntry({
          kind: "join-request",
          origin: originOf(ghostId, 1, "Ghost"),
          requestedAt: NOW,
        }),
      );
      const approvalSequence = next(thiefId);
      const approvalHash = await writeAs(
        credentials,
        membershipEntry({
          kind: "join-approved",
          origin: originOf(thiefId, approvalSequence, "Thief"),
          subject: ghostId,
          subjectKey: ghost.publicKey,
          subjectName: "Ghost",
        }),
      );
      await writeAs(
        ghostKeys,
        membershipEntry({
          kind: "join-accepted",
          origin: originOf(ghostId, 2, "Ghost"),
          approver: thiefId,
          approvalSequence,
          approvalHash,
          founder: founderId,
        }),
      );
      const victim = pick(rng, others);
      const victimKey = victim === undefined ? undefined : truth.key.get(victim);
      if (victim !== undefined && victimKey !== undefined) {
        await writeAs(
          ghostKeys,
          membershipEntry({
            kind: "join-approved",
            origin: originOf(ghostId, 3, "Ghost"),
            subject: victim,
            subjectKey: victimKey,
            subjectName: "Victim",
          }),
        );
      }
      if (rng() < 0.5) {
        const target = pick(rng, others) ?? founderId;
        trace.push(`${store.step} ghost ${ghostId.slice(0, 8)} revokes ${target.slice(0, 8)}`);
        await writeAs(
          ghostKeys,
          membershipEntry({
            kind: "revocation",
            origin: originOf(ghostId, next(ghostId), "Ghost"),
            subject: target,
            cut: Math.floor(rng() * (store.highestSequence(target) + 1)),
          }),
        );
      }
      trace.push(
        `${store.step} thief ${thiefId.slice(0, 8)} admits ghost ${ghostId.slice(0, 8)}, re-approves ${victim?.slice(0, 8)}`,
      );
      return;
    }
    if (roll < 0.65) {
      // A revocation filed under another computer's id - the founder's most
      // often - carrying and signed with the thief's own key. Its id is not
      // its key's id, so no reader may hold it. Bounded, so the slots it
      // takes never flood one computer past what a publish may skip.
      if (impersonations >= 8) return;
      impersonations += 1;
      const victim = rng() < 0.6 ? founderId : (pick(rng, others) ?? founderId);
      const subject = pick(
        rng,
        others.filter((id) => id !== victim),
      );
      const thiefKey = truth.key.get(thiefId);
      if (subject === undefined || thiefKey === undefined) return;
      await writeAs(
        credentials,
        membershipEntry({
          kind: "revocation",
          origin: {
            instanceId: victim,
            displayName: "Thief",
            sequence: next(victim),
            publicKey: thiefKey,
          },
          subject,
          cut: 0,
        }),
        thiefId,
      );
      trace.push(
        `${store.step} thief ${thiefId.slice(0, 8)} files a revocation of ${subject.slice(0, 8)} under ${victim.slice(0, 8)}`,
      );
      return;
    }
    if (roll < 0.85) {
      // Approve a real member again: with its real key, or naming the thief's own key.
      const victim = pick(rng, others);
      const realKey = victim === undefined ? undefined : truth.key.get(victim);
      const thiefKey = truth.key.get(thiefId);
      if (victim === undefined || realKey === undefined || thiefKey === undefined) return;
      const forged = rng() < 0.5;
      await writeAs(
        credentials,
        membershipEntry({
          kind: "join-approved",
          origin: originOf(thiefId, next(thiefId), "Thief"),
          subject: victim,
          subjectKey: forged ? thiefKey : realKey,
          subjectName: "Victim",
        }),
      );
      trace.push(
        `${store.step} thief ${thiefId.slice(0, 8)} approves ${victim.slice(0, 8)} ${forged ? "with its own key" : "again"}`,
      );
      return;
    }
    // A second accept for the stolen identity, naming some other approval in the store.
    const approvals = store.records().filter((entry) => entry.kind === "join-approved");
    const named = pick(rng, approvals);
    if (named === undefined) return;
    const bytes = store.files.get(`${named.origin.instanceId}/${named.origin.sequence}.json`);
    if (bytes === undefined) return;
    await writeAs(
      credentials,
      membershipEntry({
        kind: "join-accepted",
        origin: originOf(thiefId, next(thiefId), "Thief"),
        approver: named.origin.instanceId,
        approvalSequence: named.origin.sequence,
        approvalHash: createHash("sha256").update(bytes).digest("hex"),
        founder: founderId,
      }),
    );
    trace.push(
      `${store.step} thief ${thiefId.slice(0, 8)} accepts ${String(named.origin.instanceId).slice(0, 8)}@${named.origin.sequence} again`,
    );
  }

  const steps = 18 + Math.floor(rng() * 18);
  for (; store.step < steps; store.step += 1) {
    const roll = rng();
    const live = honest();
    if (roll < 0.3) {
      const joiner = pick(
        rng,
        live.filter((host) => !believesMember(host)),
      );
      const approver = pick(rng, live.filter(believesMember));
      if (joiner !== undefined && approver !== undefined) await join(joiner, approver, "scenario");
    } else if (roll < 0.62) {
      const puller = pick(
        rng,
        live.filter((host) => localId(host) !== undefined),
      );
      if (puller !== undefined) await puller.service.execute({ kind: "pull" });
    } else if (roll < 0.76) {
      const revoker = pick(rng, live.filter(believesMember));
      if (revoker === undefined) continue;
      const self = localId(revoker);
      const stolenIds = [...stolenKeys.keys()];
      const seen = membersOf(revoker).filter((id) => id !== self);
      // Mostly a stolen computer; often a relative (its approver or one it
      // approved), so revocations are tried in both directions along the tree.
      const relatives = seen.filter(
        (id) =>
          truth.parent.get(id) === self || (self !== undefined && truth.parent.get(self) === id),
      );
      const choice = rng();
      const subject =
        choice < 0.4
          ? (pick(
              rng,
              seen.filter((id) => stolenIds.includes(id)),
            ) ?? pick(rng, seen))
          : choice < 0.75
            ? (pick(rng, relatives) ?? pick(rng, seen))
            : pick(rng, seen);
      if (subject === undefined || self === undefined) continue;
      // Half the time the person also pulls first; revoke reads the store itself.
      if (rng() < 0.5) await revoker.service.execute({ kind: "pull" });
      const outcome = await revoker.service.execute({
        kind: "revoke",
        subject: subject as ReplicaInstanceId,
      });
      honestRevocations.push({ by: self, subject, outcome: reasonOf(outcome) });
      trace.push(
        `${store.step} ${revoker.name} revokes ${subject.slice(0, 8)} ${reasonOf(outcome)}`,
      );
    } else if (roll < 0.83) {
      // A non-founder member's computer is stolen; its owner stops using it.
      const victim = pick(
        rng,
        live.filter((host) => host !== founder && believesMember(host)),
      );
      const id = victim === undefined ? undefined : localId(victim);
      if (victim === undefined || id === undefined) continue;
      victim.stolen = true;
      stolenKeys.set(id, victim.credentials);
      trace.push(`${store.step} ${victim.name}(${id.slice(0, 8)}) stolen`);
    } else if (stolenKeys.size > 0) {
      await attack();
    }
    // An ancestor answers a thief. Half the time it previews the revoke and
    // revokes the computers the stolen one brought in in the same step.
    if (stolenKeys.size > 0 && rng() < 0.25) {
      const [thiefId] = pick(rng, [...stolenKeys.entries()]) ?? [];
      const parentId = thiefId === undefined ? undefined : truth.parent.get(thiefId);
      const ancestor = live.find((host) => localId(host) === parentId);
      if (ancestor !== undefined && thiefId !== undefined && parentId !== undefined) {
        let alsoRevoke: ReplicaInstanceId[] = [];
        if (rng() < 0.5) {
          const preview = await ancestor.service.execute({
            kind: "revoke-preview",
            subject: thiefId as ReplicaInstanceId,
          });
          if (preview.kind === "revoke-preview") {
            alsoRevoke = preview.broughtIn
              .filter((node) => String(node.parent) === thiefId)
              .map((node) => node.instanceId);
          }
        }
        const outcome = await ancestor.service.execute({
          kind: "revoke",
          subject: thiefId as ReplicaInstanceId,
          ...(alsoRevoke.length > 0 ? { alsoRevoke } : {}),
        });
        const landed = outcome.kind === "revoked" || outcome.kind === "revoked-in-part";
        honestRevocations.push({
          by: parentId,
          subject: thiefId,
          outcome: landed ? "revoked" : reasonOf(outcome),
        });
        if (landed) {
          for (const also of outcome.alsoRevoked) {
            honestRevocations.push({
              by: parentId,
              subject: String(also.subject),
              outcome: "revoked",
            });
          }
        }
        trace.push(
          `${store.step} ${ancestor.name} answers thief ${thiefId.slice(0, 8)} (+${alsoRevoke.length}): ${reasonOf(outcome)}`,
        );
        if (outcome.kind === "refused" && outcome.reason === "not-a-member") {
          const revokers = store
            .records()
            .filter((entry) => entry.kind === "revocation" && String(entry.subject) === parentId)
            .map((entry) => String(entry.origin.instanceId));
          if (
            revokers.length > 0 &&
            revokers.every((id) => isTrueDescendant(truth, id, parentId))
          ) {
            violations.push({
              property: "P2 precedence",
              seed,
              detail: `[lockout] ${ancestor.name} is refused as not-a-member when it revokes the stolen computer it approved, after pulling that computer's revocation of it`,
            });
          }
        }
      }
    }
  }

  // Settle: every file reaches every computer, every honest computer that is
  // not a member joins again through the founder, a late computer joins, and
  // every honest computer pulls until a round of pulls holds nothing new.
  store.settled = true;
  for (const host of honest()) {
    if (localId(host) !== undefined) await host.service.execute({ kind: "pull" });
  }
  for (const host of honest()) {
    if (host !== founder && !believesMember(host)) await join(host, founder, "settle");
  }
  const late = makeComputer(store, "Late", rng);
  await join(late, founder, "late");
  const readers = [...honest(), late];
  const lastPull = new Map<string, ReplicaMembershipResult>();
  for (let round = 0; round < 6; round += 1) {
    let applied = 0;
    for (const host of readers) {
      const pulled = await host.service.execute({ kind: "pull" });
      lastPull.set(host.name, pulled);
      if (pulled.kind === "pulled") applied += pulled.applied;
    }
    if (applied === 0) break;
  }
  // Every honest computer read the whole store as a member of the founder's
  // replica; the checks below run over all of them.
  for (const host of readers) {
    const pulled = lastPull.get(host.name);
    const pinned = host.projection.state().founder;
    if (
      pulled?.kind !== "pulled" ||
      pinned === undefined ||
      String(pinned.instanceId) !== founderId ||
      !believesMember(host)
    ) {
      stall(
        "observer",
        `${host.name} ends without reading the store as a member: pull ${pulled === undefined ? "never ran" : reasonOf(pulled)}, founder ${String(pinned?.instanceId).slice(0, 8)}, member ${String(believesMember(host))}`,
      );
    }
  }
  const observers = readers.filter(
    (host) =>
      lastPull.get(host.name)?.kind === "pulled" && host.projection.state().founder !== undefined,
  );

  // P1: every computer that read the whole store derives the same members, keys, parents, and cuts.
  const views = new Map<string, string[]>();
  for (const observer of observers) {
    const key = JSON.stringify(snapshot(observer));
    views.set(key, [...(views.get(key) ?? []), observer.name]);
  }
  if (views.size > 1) {
    violations.push({
      property: "P1 convergence",
      seed,
      detail: [...views.entries()]
        .map(([view, names]) => `${names.join(",")} => ${view}`)
        .join(" | "),
    });
  }

  const valid = store.validRecords();
  const validKeys = new Set(valid.map(heldKey));
  /**
   * A finite cut is explained by a valid record in the store: two different
   * records in the slot just after it, or a revocation naming that cut from
   * one of the computer's true ancestors.
   */
  const cutExplained = (node: string, cut: number) => {
    const inSlot = new Set(
      valid
        .filter(
          ({ entry }) =>
            String(entry.origin.instanceId) === node && entry.origin.sequence === cut + 1,
        )
        .map(({ hash }) => hash),
    );
    if (inSlot.size > 1) return true;
    return valid.some(
      ({ entry }) =>
        entry.kind === "revocation" &&
        String(entry.subject) === node &&
        entry.cut === cut &&
        isTrueDescendant(truth, node, String(entry.origin.instanceId)),
    );
  };
  for (const observer of observers) {
    // P1: every computer that read the whole store holds exactly its valid records.
    const holds = new Set(observer.projection.state().records.map(heldKey));
    const missing = [...validKeys].filter((key) => !holds.has(key));
    const extra = [...holds].filter((key) => !validKeys.has(key));
    if (missing.length > 0 || extra.length > 0) {
      violations.push({
        property: "P1 convergence",
        seed,
        detail: `[holds] ${observer.name} misses ${missing.length} valid records and holds ${extra.length} invalid ones (${[...missing, ...extra].slice(0, 2).join(", ")})`,
      });
    }
    const state = observer.projection.state();
    const member = new Map(state.members.map((m) => [String(m.instanceId), m] as const));
    const cut = new Map<string, number>();
    for (const c of state.revocations) {
      const id = String(c.instanceId);
      cut.set(id, Math.min(cut.get(id) ?? Infinity, c.lastAcceptedSequence));
    }
    // P3: every member carries the key its own identity holds.
    for (const [id, node] of member) {
      const real = truth.key.get(id);
      if (real !== undefined && real !== node.publicKey) {
        violations.push({
          property: "P3 key binding",
          seed,
          detail: `${observer.name} holds another key for ${id.slice(0, 8)}`,
        });
      }
    }
    // P2: every cut comes from a true ancestor's revocation, or a second record in its slot.
    for (const [id, at] of cut) {
      if (!cutExplained(id, at)) {
        violations.push({
          property: "P2 precedence",
          seed,
          detail: `[unexplained] ${observer.name} cuts ${id === founderId ? "the founder" : id.slice(0, 8)} at ${at} by nothing an ancestor or a second record in its slot explains`,
        });
      }
    }
    // P2: an honest ancestor's successful revocation of its descendant counts.
    for (const revocation of honestRevocations) {
      if (
        revocation.outcome !== "revoked" ||
        !isTrueDescendant(truth, revocation.subject, revocation.by)
      )
        continue;
      if (!member.has(revocation.by) || cut.has(revocation.by)) continue;
      if (member.has(revocation.subject) && !cut.has(revocation.subject)) {
        violations.push({
          property: "P2 precedence",
          seed,
          detail: `[dropped] ${observer.name} drops ${revocation.by.slice(0, 8)}'s revocation of its descendant ${revocation.subject.slice(0, 8)}`,
        });
      }
    }
    // P4: an honest member's parent is the approver it confirmed, never
    // another computer that approved it again or a ghost.
    for (const [id, node] of member) {
      if (stolenKeys.has(id) || ghosts.has(id)) continue;
      const expected = truth.parent.get(id);
      const actual = node.parent === undefined ? undefined : String(node.parent);
      if (actual !== expected) {
        violations.push({
          property: "P4 no new ancestors",
          seed,
          detail: `${observer.name} gives ${id.slice(0, 8)} parent ${String(actual).slice(0, 8)}, which it never accepted (${String(expected).slice(0, 8)})`,
        });
      }
    }
  }
  return { violations, trace };
}

// ---------------------------------------------------------------------------
// Part two: the domain derivation over abstract worlds
// ---------------------------------------------------------------------------

/**
 * Abstract records. Each carries the id it is filed under and, apart from
 * it, the key it carries and was signed with. Ids are self-certifying, so
 * `keyOf(id)` is the one key an id belongs to: a record is valid only when
 * its key is its id's key, and an approval only when the key it names is its
 * subject's - the host drops any other record before it is held. An attacker
 * holds only its own keys, so it can file a record under someone else's id
 * only with a key that is not that id's.
 */
type ModelRecord =
  | {
      readonly kind: "founded";
      readonly origin: string;
      readonly key: string;
      readonly seq: number;
    }
  | {
      readonly kind: "approve";
      readonly origin: string;
      readonly key: string;
      readonly seq: number;
      readonly subject: string;
      readonly subjectKey: string;
    }
  | {
      readonly kind: "accept";
      readonly origin: string;
      readonly key: string;
      readonly seq: number;
      readonly approver: string;
      readonly approvalSeq: number;
      readonly approvalHash: string;
    }
  | {
      readonly kind: "revoke";
      readonly origin: string;
      readonly key: string;
      readonly seq: number;
      readonly subject: string;
      readonly cut: number;
    };

const keyOf = (id: string) => `k:${id}`;

/** What the host's read path keeps: a key that is its id's, and an approval naming its subject's key. */
function modelValid(record: ModelRecord): boolean {
  return (
    record.key === keyOf(record.origin) &&
    (record.kind !== "approve" || record.subjectKey === keyOf(record.subject))
  );
}

const hashOf = (record: ModelRecord) => JSON.stringify(record);

interface ModelMembership {
  readonly parent: ReadonlyMap<string, string>;
  /** The key each computer in the tree carries. */
  readonly key: ReadonlyMap<string, string>;
  readonly admitted: ReadonlySet<string>;
  readonly cut: ReadonlyMap<string, number>;
}

const modelUuids = new Map<string, ReplicaInstanceId>();
const modelNames = new Map<string, string>();
function uuidOf(name: string): ReplicaInstanceId {
  let id = modelUuids.get(name);
  if (id === undefined) {
    const serial = (modelUuids.size + 1).toString(16).padStart(12, "0");
    id = `00000000-0000-8000-8000-${serial}` as ReplicaInstanceId;
    modelUuids.set(name, id);
    modelNames.set(String(id), name);
  }
  return id;
}
const nameOf = (id: ReplicaInstanceId) => modelNames.get(String(id)) ?? String(id);

function heldRecord(founder: string, record: ModelRecord): ReplicaHeldRecord {
  const origin = {
    instanceId: uuidOf(record.origin),
    displayName: record.origin,
    sequence: record.seq,
    publicKey: record.key,
  };
  const head = { format: REPLICA_ENTRY_FORMAT, origin } as const;
  const hash = hashOf(record);
  switch (record.kind) {
    case "founded":
      return { hash, entry: { ...head, kind: "replica-founded" } };
    case "approve":
      return {
        hash,
        entry: {
          ...head,
          kind: "join-approved",
          subject: uuidOf(record.subject),
          subjectKey: record.subjectKey,
          subjectName: record.subject,
        },
      };
    case "accept":
      return {
        hash,
        entry: {
          ...head,
          kind: "join-accepted",
          approver: uuidOf(record.approver),
          approvalSequence: record.approvalSeq,
          approvalHash: record.approvalHash,
          founder: uuidOf(founder),
        },
      };
    case "revoke":
      return {
        hash,
        entry: { ...head, kind: "revocation", subject: uuidOf(record.subject), cut: record.cut },
      };
  }
}

/** The domain derivation over the records a reader holds. */
function deriveReal(founder: string, input: ReadonlyArray<ModelRecord>): ModelMembership {
  const held = input.filter(modelValid).map((record) => heldRecord(founder, record));
  const membership = deriveReplicaMembership(uuidOf(founder), held);
  const parent = new Map<string, string>();
  const key = new Map<string, string>();
  const admitted = new Set<string>();
  const cut = new Map<string, number>();
  for (const node of membership.nodes) {
    const name = nameOf(node.instanceId);
    key.set(name, node.publicKey);
    if (node.parent !== undefined) parent.set(name, nameOf(node.parent));
    if (node.admitted) admitted.add(name);
    cut.set(name, node.cut ?? Infinity);
  }
  return { parent, key, admitted, cut };
}

/**
 * Whether a finite cut is explained by a record the reader holds: two
 * different records in the slot just after it, or a revocation naming that cut
 * from one of the computer's true ancestors.
 */
function cutExplained(
  truth: Truth,
  holding: ReadonlyArray<ModelRecord>,
  node: string,
  cut: number,
): boolean {
  const valid = holding.filter(modelValid);
  const inSlot = new Set(
    valid
      .filter((record) => record.origin === node && record.seq === cut + 1)
      .map((record) => hashOf(record)),
  );
  if (inSlot.size > 1) return true;
  return valid.some(
    (record) =>
      record.kind === "revoke" &&
      record.subject === node &&
      record.cut === cut &&
      isTrueDescendant(truth, node, record.origin),
  );
}

interface ModelWorld {
  readonly founder: string;
  readonly records: ReadonlyArray<ModelRecord>;
  /** Records written with stolen or ghost keys. */
  readonly attacker: ReadonlySet<string>;
  readonly truth: Truth;
  readonly compromised: ReadonlySet<string>;
  /** Honest revocations: an ancestor in good standing revoked its descendant. */
  readonly honestRevocations: ReadonlyArray<Extract<ModelRecord, { kind: "revoke" }>>;
}

function modelWorld(seed: number): ModelWorld {
  const rng = rngFor(seed + 100_000);
  const founder = "F";
  const records: ModelRecord[] = [
    { kind: "founded", origin: founder, key: keyOf(founder), seq: 1 },
  ];
  const attacker = new Set<string>();
  const truth: Truth = { key: new Map([[founder, keyOf(founder)]]), parent: new Map() };
  const compromised = new Set<string>();
  const sequence = new Map<string, number>([[founder, 1]]);
  const next = (id: string) => {
    const value = (sequence.get(id) ?? 0) + 1;
    sequence.set(id, value);
    return value;
  };
  const honestRevocations: Array<Extract<ModelRecord, { kind: "revoke" }>> = [];
  const add = (record: ModelRecord, byAttacker: boolean) => {
    records.push(record);
    if (byAttacker) attacker.add(hashOf(record));
  };
  let made = 0;
  const steps = 20 + Math.floor(rng() * 30);
  for (let step = 0; step < steps; step += 1) {
    const nodes = [...truth.key.keys()];
    const current = deriveReal(founder, records);
    const roll = rng();
    if (roll < 0.35) {
      // An honest join: approval, then the joiner's accept.
      const approver = pick(
        rng,
        nodes.filter(
          (id) =>
            !compromised.has(id) &&
            current.admitted.has(id) &&
            (current.cut.get(id) ?? Infinity) === Infinity,
        ),
      );
      if (approver === undefined) continue;
      made += 1;
      const joiner = `N${made}`;
      truth.key.set(joiner, keyOf(joiner));
      sequence.set(joiner, 1);
      const approval: ModelRecord = {
        kind: "approve",
        origin: approver,
        key: keyOf(approver),
        seq: next(approver),
        subject: joiner,
        subjectKey: keyOf(joiner),
      };
      add(approval, false);
      add(
        {
          kind: "accept",
          origin: joiner,
          key: keyOf(joiner),
          seq: next(joiner),
          approver,
          approvalSeq: approval.seq,
          approvalHash: hashOf(approval),
        },
        false,
      );
      truth.parent.set(joiner, approver);
    } else if (roll < 0.55) {
      // An honest revocation, only of a descendant, cut at what it holds.
      const revoker = pick(
        rng,
        nodes.filter(
          (id) =>
            !compromised.has(id) &&
            current.admitted.has(id) &&
            (current.cut.get(id) ?? Infinity) === Infinity,
        ),
      );
      if (revoker === undefined) continue;
      const subject = pick(
        rng,
        nodes.filter((id) => isTrueDescendant(truth, id, revoker)),
      );
      if (subject === undefined) continue;
      const record: Extract<ModelRecord, { kind: "revoke" }> = {
        kind: "revoke",
        origin: revoker,
        key: keyOf(revoker),
        seq: next(revoker),
        subject,
        cut: sequence.get(subject) ?? 0,
      };
      add(record, false);
      honestRevocations.push(record);
    } else if (roll < 0.62) {
      const victim = pick(
        rng,
        nodes.filter((id) => id !== founder && !compromised.has(id)),
      );
      if (victim !== undefined) compromised.add(victim);
    } else if (compromised.size > 0) {
      const thief = pick(rng, [...compromised]);
      if (thief === undefined) continue;
      const target =
        pick(
          rng,
          nodes.filter((id) => id !== thief),
        ) ?? founder;
      const kind = rng();
      // A folder-store rewrite: the thief signs a second record into a slot it already used.
      const seq =
        rng() < 0.1 ? Math.max(2, Math.floor(rng() * (sequence.get(thief) ?? 2)) + 1) : next(thief);
      if (kind < 0.3) {
        add(
          {
            kind: "revoke",
            origin: thief,
            key: keyOf(thief),
            seq,
            subject: rng() < 0.6 ? (truth.parent.get(thief) ?? founder) : target,
            cut: Math.floor(rng() * ((sequence.get(target) ?? 1) + 1)),
          },
          true,
        );
      } else if (kind < 0.5) {
        made += 1;
        const ghost = `G${made}`;
        truth.key.set(ghost, keyOf(ghost));
        truth.parent.set(ghost, thief);
        compromised.add(ghost);
        sequence.set(ghost, 1);
        const approval: ModelRecord = {
          kind: "approve",
          origin: thief,
          key: keyOf(thief),
          seq,
          subject: ghost,
          subjectKey: keyOf(ghost),
        };
        add(approval, true);
        add(
          {
            kind: "accept",
            origin: ghost,
            key: keyOf(ghost),
            seq: next(ghost),
            approver: thief,
            approvalSeq: seq,
            approvalHash: hashOf(approval),
          },
          true,
        );
        add(
          {
            kind: "approve",
            origin: ghost,
            key: keyOf(ghost),
            seq: next(ghost),
            subject: target,
            subjectKey: keyOf(target),
          },
          true,
        );
      } else if (kind < 0.65) {
        // Re-approve a real member, with its key or naming the thief's own.
        add(
          {
            kind: "approve",
            origin: thief,
            key: keyOf(thief),
            seq,
            subject: target,
            subjectKey: keyOf(rng() < 0.5 ? target : thief),
          },
          true,
        );
      } else if (kind < 0.8) {
        // A record filed under someone else's id with the thief's own key: an
        // accept that would give the target the thief's key, or a revocation
        // in an ancestor's name - the founder's most often.
        const approval = records.find(
          (record) =>
            record.kind === "approve" && record.subject === target && !attacker.has(hashOf(record)),
        );
        if (approval !== undefined && rng() < 0.5) {
          add(
            {
              kind: "accept",
              origin: target,
              key: keyOf(thief),
              seq: 1,
              approver: approval.origin,
              approvalSeq: approval.seq,
              approvalHash: hashOf(approval),
            },
            true,
          );
        } else {
          const victim = rng() < 0.6 ? founder : target;
          const subject = pick(
            rng,
            nodes.filter((id) => id !== victim),
          );
          if (subject === undefined) continue;
          add(
            {
              kind: "revoke",
              origin: victim,
              key: keyOf(thief),
              seq: next(victim),
              subject,
              cut: 0,
            },
            true,
          );
        }
      } else {
        // The thief signs a second accept for itself, naming a different approver.
        const other = pick(
          rng,
          nodes.filter((id) => id !== thief),
        );
        if (other === undefined) continue;
        add(
          {
            kind: "accept",
            origin: thief,
            key: keyOf(thief),
            seq,
            approver: other,
            approvalSeq: 1,
            approvalHash: "none",
          },
          true,
        );
      }
    }
  }
  return { founder, records, attacker, truth, compromised, honestRevocations };
}

function sameMembership(left: ModelMembership, right: ModelMembership): boolean {
  const flat = (m: ModelMembership) =>
    JSON.stringify([
      [...m.parent.entries()].sort(),
      [...m.admitted].sort(),
      [...m.cut.entries()].map(([id, value]) => [id, String(value)]).sort(),
    ]);
  return flat(left) === flat(right);
}

function checkModel(seed: number): ReadonlyArray<Violation> {
  const world = modelWorld(seed);
  const rng = rngFor(seed + 200_000);
  const violations: Violation[] = [];
  const full = deriveReal(world.founder, world.records);
  // P1: the same set, in any order and with duplicates, gives the same answer;
  // readers holding random subsets agree once they hold the same records.
  for (let reader = 0; reader < 5; reader += 1) {
    const subset = shuffled(rng, world.records).filter(() => rng() < 0.7);
    const again = shuffled(rng, [...subset, ...subset.filter(() => rng() < 0.3)]);
    if (!sameMembership(deriveReal(world.founder, subset), deriveReal(world.founder, again))) {
      violations.push({
        property: "P1 convergence",
        seed,
        detail: `reader ${reader} differs on a reordered copy of its own set`,
      });
    }
    const merged = [...subset, ...shuffled(rng, world.records)];
    if (!sameMembership(deriveReal(world.founder, merged), full)) {
      violations.push({
        property: "P1 convergence",
        seed,
        detail: `reader ${reader} differs after reading everything`,
      });
    }
  }
  for (const holding of [world.records, shuffled(rng, world.records).filter(() => rng() < 0.6)]) {
    const derived = deriveReal(world.founder, holding);
    // P2: nobody is cut by a revocation from below, and an honest ancestor's revocation counts.
    for (const [node, cut] of derived.cut) {
      if (Number.isFinite(cut) && !cutExplained(world.truth, holding, node, cut)) {
        violations.push({
          property: "P2 precedence",
          seed,
          detail: `${node} is cut at ${cut} by nothing an ancestor or a second record in its slot explains`,
        });
      }
    }
    for (const revocation of world.honestRevocations) {
      if (!holding.includes(revocation)) continue;
      const by = revocation.origin;
      if (!derived.admitted.has(by) || revocation.seq > (derived.cut.get(by) ?? Infinity)) continue;
      if (!derived.parent.has(revocation.subject)) continue;
      if ((derived.cut.get(revocation.subject) ?? Infinity) > revocation.cut) {
        violations.push({
          property: "P2 precedence",
          seed,
          detail: `${by}'s revocation of ${revocation.subject} does not count`,
        });
      }
    }
    // P3: every admitted member carries its own id's key.
    for (const node of derived.admitted) {
      if (derived.key.get(node) !== world.truth.key.get(node)) {
        violations.push({
          property: "P3 key binding",
          seed,
          detail: `${node} admitted with key ${String(derived.key.get(node))}`,
        });
      }
    }
    // P4: a computer's parent is the approver it accepted, never anyone else.
    for (const [node, up] of derived.parent) {
      if (world.compromised.has(node)) continue;
      if (world.truth.parent.get(node) !== up) {
        violations.push({
          property: "P4 no new ancestors",
          seed,
          detail: `${node} has parent ${up}, accepted ${String(world.truth.parent.get(node))}`,
        });
      }
    }
  }
  // Blast radius: removing every record a stolen key wrote changes nothing for
  // an honest computer outside the stolen computers' subtrees.
  const honestOnly = deriveReal(
    world.founder,
    world.records.filter((record) => !world.attacker.has(hashOf(record))),
  );
  for (const node of world.truth.key.keys()) {
    if (world.compromised.has(node)) continue;
    if ([...world.compromised].some((thief) => isTrueDescendant(world.truth, node, thief)))
      continue;
    const before = `${honestOnly.admitted.has(node)}/${String(honestOnly.cut.get(node))}/${String(honestOnly.parent.get(node))}`;
    const after = `${full.admitted.has(node)}/${String(full.cut.get(node))}/${String(full.parent.get(node))}`;
    if (before !== after) {
      violations.push({
        property: "P2 precedence",
        seed,
        detail: `stolen keys change ${node} outside their subtree: ${before} -> ${after}`,
      });
    }
  }
  return violations;
}

// ---------------------------------------------------------------------------

describe("replica membership convergence (service and projection)", () => {
  const all: Violation[] = [];
  let ran = false;
  const runAll = async () => {
    if (ran) return;
    ran = true;
    for (let seed = 1; seed <= SEEDS; seed += 1) {
      const run = await runCurrent(seed);
      all.push(...run.violations);
      const tracePath = process.env.OCTANT_REPLICA_FUZZ_TRACE;
      if (tracePath !== undefined && process.env.OCTANT_REPLICA_FUZZ_SEED === String(seed)) {
        writeFileSync(tracePath, `${run.trace.join("\n")}\n`);
      }
    }
    const report = SERVICE_PROPERTIES.map((property) => summarize(all, property, SEEDS)).join("\n");
    const reportPath = process.env.OCTANT_REPLICA_FUZZ_REPORT;
    if (reportPath !== undefined) writeFileSync(reportPath, `${report}\n`);
  };
  for (const property of SERVICE_PROPERTIES) {
    it(`holds ${property} on every seed`, { timeout: 600_000 }, async () => {
      await runAll();
      expect(
        all.filter((v) => v.property === property),
        summarize(all, property, SEEDS),
      ).toEqual([]);
    });
  }
});

describe("replica membership convergence (domain derivation)", () => {
  const all: Violation[] = [];
  const worlds = SEEDS * 25;
  for (let seed = 1; seed <= worlds; seed += 1) all.push(...checkModel(seed));
  for (const property of DERIVATION_PROPERTIES) {
    it(`holds ${property} on every seed`, () => {
      expect(
        all.filter((v) => v.property === property),
        summarize(all, property, worlds),
      ).toEqual([]);
    });
  }
});
