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
 * joins and pulls everything. The properties are then checked against the
 * ground truth the harness recorded: who confirmed which approver, and which
 * key belongs to which identity.
 *
 * Part two runs the same properties against a reference model of the
 * proposed protocol (the derivation in the design note), over sets of
 * abstract records, so the design is checked by the same assertions before
 * any of it is built.
 *
 * Seeds are reproducible: ids, steps, and lag come from the seed, and only
 * the Ed25519 key bytes differ between runs, which no decision orders by.
 * OCTANT_REPLICA_FUZZ_SEEDS sets how many seeds run (default 40).
 */

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
import type { ReplicaStore, ReplicaStorePutResult } from "@octant/plugin-api/replica-store";
import { AggregateHeadsProjection } from "../persistence/aggregateHeadsProjection";
import { EventRegistry } from "../persistence/eventRegistry";
import { Journal } from "../persistence/journal";
import { applyMigrations, MIGRATIONS } from "../persistence/migrations";
import { ProjectionRegistry } from "../persistence/projection";
import { openSqlite } from "../persistence/sqlitePort";
import { ensureReplicaDeviceKey, makeReplicaDeviceSigner } from "./replicaDeviceKeyService";
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

function randomInstanceId(rng: Rng): ReplicaInstanceId {
  const hex = (length: number) =>
    Array.from({ length }, () => Math.floor(rng() * 16).toString(16)).join("");
  return `${hex(8)}-${hex(4)}-4${hex(3)}-8${hex(3)}-${hex(12)}` as ReplicaInstanceId;
}

interface Violation {
  readonly property: Property;
  readonly seed: number;
  readonly detail: string;
}

type Property = "P1 convergence" | "P2 precedence" | "P3 key binding" | "P4 no new ancestors";

const PROPERTIES: ReadonlyArray<Property> = [
  "P1 convergence",
  "P2 precedence",
  "P3 key binding",
  "P4 no new ancestors",
];

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

function summarize(violations: ReadonlyArray<Violation>, property: Property): string {
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
  return `${property}: ${seeds.length}/${SEEDS} seeds fail\n${byKind}\n${examples}`;
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

  /** Every membership record in the store, decoded. Every file the harness writes is signed validly. */
  records(): ReadonlyArray<ReplicaMembershipEntry> {
    const result: ReplicaMembershipEntry[] = [];
    for (const [key, bytes] of this.files) {
      if (!key.endsWith(".json")) continue;
      const entry = decodeReplicaEntryText(new TextDecoder().decode(bytes));
      if (
        entry.kind === "join-request" ||
        entry.kind === "join-approved" ||
        entry.kind === "revocation"
      ) {
        result.push(entry);
      }
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

function makeComputer(store: LaggedStore, name: string, nextId: () => ReplicaInstanceId): Computer {
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
      ensure: (instanceId) => ensureReplicaDeviceKey(credentials, instanceId),
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
    newInstanceId: nextId,
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
      .map((member) => `${String(member.instanceId).slice(0, 8)}:${member.publicKey.slice(16, 24)}`)
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
  const nextId = () => randomInstanceId(rng);
  const count = 3 + Math.floor(rng() * 4);
  const computers = Array.from({ length: count }, (_, index) =>
    makeComputer(store, `C${index}`, nextId),
  );
  const [founder] = computers;
  if (founder === undefined) throw new Error("no founder");
  const created = await founder.service.execute({ kind: "create-replica", displayName: "C0" });
  if (created.kind !== "replica-created") throw new Error(`founding failed: ${reasonOf(created)}`);
  const founderId = String(created.instanceId);
  const founderKey = created.entry.subjectDeviceKey;
  if (founderKey !== undefined) truth.key.set(founderId, founderKey);
  // Keys the thief holds: stolen computers' identities and its own ghosts.
  const stolenKeys = new Map<string, CredentialStore>();
  const ghostKeys = memoryCredentialStore();
  const honestRevocations: Array<{ by: string; subject: string; outcome: string }> = [];

  const honest = () => computers.filter((host) => !host.stolen);
  const membersOf = (host: Computer) =>
    host.projection.state().members.map((member) => String(member.instanceId));

  async function join(joiner: Computer, approver: Computer): Promise<void> {
    const approverId = localId(approver);
    if (approverId === undefined) return;
    const request = await joiner.service.execute({
      kind: "write-join-request",
      displayName: joiner.name,
    });
    if (request.kind !== "join-requested") {
      trace.push(`${store.step} ${joiner.name} request ${reasonOf(request)}`);
      return;
    }
    const joinerId = String(request.instanceId);
    const key = request.entry.subjectDeviceKey;
    if (key !== undefined) truth.key.set(joinerId, key);
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
    if (approved.kind !== "join-approved") return;
    store.revealAll(joiner.name);
    const confirmed = await joiner.service.execute({
      kind: "confirm-join",
      approver: approverId as ReplicaInstanceId,
      confirmationCode: code,
    });
    trace.push(`${store.step} ${joiner.name} confirms ${reasonOf(confirmed)}`);
    if (confirmed.kind === "join-confirmed") truth.parent.set(joinerId, approverId);
  }

  async function writeAs(
    credentials: CredentialStore,
    entry: ReplicaMembershipEntry,
  ): Promise<void> {
    const bytes = new TextEncoder().encode(encodeReplicaEntry(entry));
    const { signature } = await makeReplicaDeviceSigner(credentials, entry.origin.instanceId).sign(
      bytes,
    );
    const path = `${entry.origin.instanceId}/${entry.origin.sequence}`;
    store.write("thief", `${path}.sig`, new TextEncoder().encode(signature));
    store.write("thief", `${path}.json`, bytes);
  }

  async function attack(): Promise<void> {
    const [thiefId, credentials] = pick(rng, [...stolenKeys.entries()]) ?? [];
    if (thiefId === undefined || credentials === undefined) return;
    const others = [...truth.key.keys()].filter((id) => id !== thiefId);
    const roll = rng();
    const next = (id: string) => store.highestSequence(id) + 1;
    if (roll < 0.45) {
      // Revoke an ancestor (its approver, or the founder) or anyone else.
      const target =
        rng() < 0.7 ? (truth.parent.get(thiefId) ?? founderId) : (pick(rng, others) ?? founderId);
      const cut = Math.floor(rng() * (store.highestSequence(target) + 1));
      await writeAs(
        credentials,
        membershipEntry({
          kind: "revocation",
          origin: { instanceId: thiefId, displayName: "Thief", sequence: next(thiefId) },
          subject: target,
          subjectDisplayName: "Target",
          lastAcceptedSequence: cut,
        }),
      );
      trace.push(`${store.step} thief ${thiefId.slice(0, 8)} revokes ${target.slice(0, 8)}@${cut}`);
      return;
    }
    if (roll < 0.75) {
      // A ghost: the stolen key admits a fresh identity, which approves a real
      // member again with its real key and may revoke someone.
      const ghostId = randomInstanceId(rng);
      const ghostKey = (await ensureReplicaDeviceKey(ghostKeys, ghostId)).publicKey;
      truth.key.set(ghostId, ghostKey);
      truth.parent.set(ghostId, thiefId);
      await writeAs(
        ghostKeys,
        membershipEntry({
          kind: "join-request",
          origin: { instanceId: ghostId, displayName: "Ghost", sequence: 1 },
          subject: ghostId,
          subjectDisplayName: "Ghost",
          subjectDeviceKey: ghostKey,
          requestedAt: NOW,
        }),
      );
      await writeAs(
        credentials,
        membershipEntry({
          kind: "join-approved",
          origin: { instanceId: thiefId, displayName: "Thief", sequence: next(thiefId) },
          subject: ghostId,
          subjectDisplayName: "Ghost",
          subjectDeviceKey: ghostKey,
        }),
      );
      const victim = pick(rng, others);
      const victimKey = victim === undefined ? undefined : truth.key.get(victim);
      if (victim !== undefined && victimKey !== undefined) {
        await writeAs(
          ghostKeys,
          membershipEntry({
            kind: "join-approved",
            origin: { instanceId: ghostId, displayName: "Ghost", sequence: 2 },
            subject: victim,
            subjectDisplayName: "Victim",
            subjectDeviceKey: victimKey,
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
            origin: { instanceId: ghostId, displayName: "Ghost", sequence: next(ghostId) },
            subject: target,
            subjectDisplayName: "Target",
            lastAcceptedSequence: Math.floor(rng() * (store.highestSequence(target) + 1)),
          }),
        );
      }
      trace.push(
        `${store.step} thief ${thiefId.slice(0, 8)} admits ghost ${ghostId.slice(0, 8)}, re-approves ${victim?.slice(0, 8)}`,
      );
      return;
    }
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
        origin: { instanceId: thiefId, displayName: "Thief", sequence: next(thiefId) },
        subject: victim,
        subjectDisplayName: "Victim",
        subjectDeviceKey: forged ? thiefKey : realKey,
      }),
    );
    trace.push(
      `${store.step} thief ${thiefId.slice(0, 8)} approves ${victim.slice(0, 8)} ${forged ? "with its own key" : "again"}`,
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
      if (joiner !== undefined && approver !== undefined) await join(joiner, approver);
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
      // approved), so revocations cross in both directions along the tree.
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
      // Half the time the person revokes without pulling first.
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
    // An ancestor answers a thief: it pulls, then revokes the stolen key.
    if (stolenKeys.size > 0 && rng() < 0.25) {
      const [thiefId] = pick(rng, [...stolenKeys.entries()]) ?? [];
      const parentId = thiefId === undefined ? undefined : truth.parent.get(thiefId);
      const ancestor = live.find((host) => localId(host) === parentId);
      if (ancestor !== undefined && thiefId !== undefined && parentId !== undefined) {
        await ancestor.service.execute({ kind: "pull" });
        const outcome = await ancestor.service.execute({
          kind: "revoke",
          subject: thiefId as ReplicaInstanceId,
        });
        honestRevocations.push({ by: parentId, subject: thiefId, outcome: reasonOf(outcome) });
        trace.push(
          `${store.step} ${ancestor.name} answers thief ${thiefId.slice(0, 8)}: ${reasonOf(outcome)}`,
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

  // Settle: every file reaches every computer, a late computer joins, and
  // every honest computer pulls until a round of pulls applies nothing.
  store.settled = true;
  const late = makeComputer(store, "Late", nextId);
  const entry =
    honest().find((host) => localId(host) === founderId && believesMember(host)) ??
    pick(rng, honest().filter(believesMember));
  if (entry !== undefined) await join(late, entry);
  const readers = [...honest(), late].filter((host) => localId(host) !== undefined);
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
  const observers = readers.filter((host) => lastPull.get(host.name)?.kind === "pulled");

  // P1: every computer that read the whole store derives the same members, keys, and cuts.
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

  const records = store.records();
  const revocations = records.filter((entry) => entry.kind === "revocation");
  for (const observer of observers) {
    const state = observer.projection.state();
    const member = new Map(state.members.map((m) => [String(m.instanceId), m.publicKey] as const));
    const cut = new Map<string, number>();
    for (const c of state.revocations) {
      const id = String(c.instanceId);
      cut.set(id, Math.min(cut.get(id) ?? Infinity, c.lastAcceptedSequence));
    }
    // P3: every member carries the key its own identity holds.
    for (const [id, publicKey] of member) {
      const real = truth.key.get(id);
      if (real !== undefined && real !== publicKey) {
        violations.push({
          property: "P3 key binding",
          seed,
          detail: `${observer.name} holds another key for ${id.slice(0, 8)}`,
        });
      }
    }
    // P2: no computer stays revoked only by computers it brought in.
    for (const id of cut.keys()) {
      const revokers = revocations
        .filter((entry) => String(entry.subject) === id)
        .map((entry) => String(entry.origin.instanceId));
      if (
        revokers.length > 0 &&
        revokers.every((revoker) => isTrueDescendant(truth, revoker, id))
      ) {
        violations.push({
          property: "P2 precedence",
          seed,
          detail: `[from below] ${observer.name} keeps ${id === founderId ? "the founder" : id.slice(0, 8)} revoked only by its own descendants ${revokers.map((r) => r.slice(0, 8)).join(",")}`,
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
    // P4: a revocation by a member in good standing is discarded only when its
    // target really is that member's ancestor. Discarding it otherwise means
    // the derivation treated the target as an ancestor it never was.
    for (const revocation of revocations) {
      const revoker = String(revocation.origin.instanceId);
      const target = String(revocation.subject);
      if (revoker === target || !member.has(revoker) || !member.has(target)) continue;
      if (revocation.origin.sequence > (cut.get(revoker) ?? Infinity)) continue;
      if (isTrueDescendant(truth, revoker, target) || cut.has(target)) continue;
      violations.push({
        property: "P4 no new ancestors",
        seed,
        detail: `${observer.name} ignores ${revoker.slice(0, 8)}'s revocation of ${target.slice(0, 8)}, which never approved it`,
      });
    }
  }
  return { violations, trace };
}

// ---------------------------------------------------------------------------
// Part two: a reference model of the proposed protocol
// ---------------------------------------------------------------------------

/**
 * Abstract records. An id stands for its key (ids are self-certifying), so a
 * record is valid exactly when the harness let the key holder write it, and
 * an approval is valid only when the key it names is the subject's id.
 */
type ModelRecord =
  | { readonly kind: "founded"; readonly origin: string; readonly seq: number }
  | {
      readonly kind: "approve";
      readonly origin: string;
      readonly seq: number;
      readonly subject: string;
      readonly subjectKey: string;
    }
  | {
      readonly kind: "accept";
      readonly origin: string;
      readonly seq: number;
      readonly approver: string;
      readonly approvalSeq: number;
      readonly approvalHash: string;
    }
  | {
      readonly kind: "revoke";
      readonly origin: string;
      readonly seq: number;
      readonly subject: string;
      readonly cut: number;
    };

const hashOf = (record: ModelRecord) => JSON.stringify(record);

interface ModelMembership {
  readonly parent: ReadonlyMap<string, string>;
  readonly admitted: ReadonlySet<string>;
  readonly cut: ReadonlyMap<string, number>;
  /** What set each finite cut: "equivocation", or the revoker whose cut counted. */
  readonly cause: ReadonlyMap<string, string>;
}

/** The derivation in the design note, section 2, over a set of records. */
function deriveModel(founder: string, input: ReadonlyArray<ModelRecord>): ModelMembership {
  const byHash = new Map(input.map((record) => [hashOf(record), record] as const));
  const records = [...byHash.values()].filter(
    (record) => record.kind !== "approve" || record.subject === record.subjectKey,
  );
  // 2a: equivocation cap.
  const slots = new Map<string, number>();
  for (const record of records) {
    const slot = `${record.origin}/${record.seq}`;
    slots.set(slot, (slots.get(slot) ?? 0) + 1);
  }
  const eq = new Map<string, number>();
  for (const [slot, count] of slots) {
    if (count < 2) continue;
    const [origin = "", seq = "0"] = slot.split("/");
    eq.set(origin, Math.min(eq.get(origin) ?? Infinity, Number(seq)));
  }
  const live = records.filter((record) => record.seq < (eq.get(record.origin) ?? Infinity));
  // 2b: the parent tree from each joiner's lowest accept.
  if (
    !live.some(
      (record) => record.kind === "founded" && record.origin === founder && record.seq === 1,
    )
  ) {
    return { parent: new Map(), admitted: new Set(), cut: new Map(), cause: new Map() };
  }
  const firstAccept = new Map<string, Extract<ModelRecord, { kind: "accept" }>>();
  for (const record of live) {
    if (record.kind !== "accept" || record.origin === founder) continue;
    const known = firstAccept.get(record.origin);
    if (known === undefined || record.seq < known.seq) firstAccept.set(record.origin, record);
  }
  const edge = new Map<string, { readonly parent: string; readonly approvalSeq: number }>();
  for (const [child, accept] of firstAccept) {
    const approval = byHash.get(accept.approvalHash);
    if (
      approval?.kind === "approve" &&
      live.includes(approval) &&
      approval.origin === accept.approver &&
      approval.seq === accept.approvalSeq &&
      approval.subject === child
    ) {
      edge.set(child, { parent: accept.approver, approvalSeq: accept.approvalSeq });
    }
  }
  const order: string[] = [founder];
  const parent = new Map<string, string>();
  for (let index = 0; index < order.length; index += 1) {
    const node = order[index];
    for (const [child, link] of edge) {
      if (link.parent === node && !parent.has(child) && child !== founder) {
        parent.set(child, link.parent);
        order.push(child);
      }
    }
  }
  const ancestors = (node: string) => {
    const result: string[] = [];
    for (let current = parent.get(node); current !== undefined; current = parent.get(current)) {
      result.push(current);
    }
    return result;
  };
  // 2c: top-down standing.
  const admitted = new Set<string>([founder]);
  const cut = new Map<string, number>([[founder, (eq.get(founder) ?? Infinity) - 1]]);
  const cause = new Map<string, string>(eq.has(founder) ? [[founder, "equivocation"]] : []);
  for (const node of order.slice(1)) {
    const up = parent.get(node);
    const link = edge.get(node);
    if (up === undefined || link === undefined) continue;
    if (admitted.has(up) && link.approvalSeq <= (cut.get(up) ?? Infinity)) admitted.add(node);
    const above = new Set(ancestors(node));
    let lowest = (eq.get(node) ?? Infinity) - 1;
    if (eq.has(node)) cause.set(node, "equivocation");
    for (const record of live) {
      if (record.kind !== "revoke" || record.subject !== node || !above.has(record.origin))
        continue;
      if (!admitted.has(record.origin) || record.seq > (cut.get(record.origin) ?? Infinity))
        continue;
      if (record.cut < lowest) {
        lowest = record.cut;
        cause.set(node, record.origin);
      }
    }
    cut.set(node, lowest);
  }
  return { parent, admitted, cut, cause };
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
  const records: ModelRecord[] = [{ kind: "founded", origin: founder, seq: 1 }];
  const attacker = new Set<string>();
  const truth: Truth = { key: new Map([[founder, founder]]), parent: new Map() };
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
    const current = deriveModel(founder, records);
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
      truth.key.set(joiner, joiner);
      sequence.set(joiner, 1);
      const approval: ModelRecord = {
        kind: "approve",
        origin: approver,
        seq: next(approver),
        subject: joiner,
        subjectKey: joiner,
      };
      add(approval, false);
      add(
        {
          kind: "accept",
          origin: joiner,
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
      if (kind < 0.35) {
        add(
          {
            kind: "revoke",
            origin: thief,
            seq,
            subject: rng() < 0.6 ? (truth.parent.get(thief) ?? founder) : target,
            cut: Math.floor(rng() * ((sequence.get(target) ?? 1) + 1)),
          },
          true,
        );
      } else if (kind < 0.6) {
        made += 1;
        const ghost = `G${made}`;
        truth.key.set(ghost, ghost);
        truth.parent.set(ghost, thief);
        compromised.add(ghost);
        sequence.set(ghost, 1);
        const approval: ModelRecord = {
          kind: "approve",
          origin: thief,
          seq,
          subject: ghost,
          subjectKey: ghost,
        };
        add(approval, true);
        add(
          {
            kind: "accept",
            origin: ghost,
            seq: next(ghost),
            approver: thief,
            approvalSeq: seq,
            approvalHash: hashOf(approval),
          },
          true,
        );
        add(
          { kind: "approve", origin: ghost, seq: next(ghost), subject: target, subjectKey: target },
          true,
        );
      } else if (kind < 0.8) {
        // Re-approve a real member, with its key or naming the thief's own.
        add(
          {
            kind: "approve",
            origin: thief,
            seq,
            subject: target,
            subjectKey: rng() < 0.5 ? target : thief,
          },
          true,
        );
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
  const full = deriveModel(world.founder, world.records);
  // P1: the same set, in any order and with duplicates, gives the same answer;
  // readers holding random subsets agree once they hold the same records.
  for (let reader = 0; reader < 5; reader += 1) {
    const subset = shuffled(rng, world.records).filter(() => rng() < 0.7);
    const again = shuffled(rng, [...subset, ...subset.filter(() => rng() < 0.3)]);
    if (!sameMembership(deriveModel(world.founder, subset), deriveModel(world.founder, again))) {
      violations.push({
        property: "P1 convergence",
        seed,
        detail: `reader ${reader} differs on a reordered copy of its own set`,
      });
    }
    const merged = [...subset, ...shuffled(rng, world.records)];
    if (!sameMembership(deriveModel(world.founder, merged), full)) {
      violations.push({
        property: "P1 convergence",
        seed,
        detail: `reader ${reader} differs after reading everything`,
      });
    }
  }
  for (const holding of [world.records, shuffled(rng, world.records).filter(() => rng() < 0.6)]) {
    const derived = deriveModel(world.founder, holding);
    // P2: nobody is cut by a revocation from below, and an honest ancestor's revocation counts.
    for (const [node, by] of derived.cause) {
      if (by !== "equivocation" && !isTrueDescendant(world.truth, node, by)) {
        violations.push({
          property: "P2 precedence",
          seed,
          detail: `${node} cut by ${by}, which is not its ancestor`,
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
    // P3: every admitted member was admitted for its own key.
    for (const node of derived.admitted) {
      if (world.truth.key.get(node) !== node) {
        violations.push({
          property: "P3 key binding",
          seed,
          detail: `${node} admitted without its own key`,
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
  const honestOnly = deriveModel(
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

describe("replica membership convergence (current service)", () => {
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
    const report = PROPERTIES.map((property) => summarize(all, property)).join("\n");
    const reportPath = process.env.OCTANT_REPLICA_FUZZ_REPORT;
    if (reportPath !== undefined) writeFileSync(reportPath, `${report}\n`);
  };
  for (const property of PROPERTIES) {
    it(`holds ${property} on every seed`, { timeout: 600_000 }, async () => {
      await runAll();
      expect(
        all.filter((v) => v.property === property),
        summarize(all, property),
      ).toEqual([]);
    });
  }
});

describe("replica membership convergence (proposed protocol model)", () => {
  const all: Violation[] = [];
  for (let seed = 1; seed <= SEEDS * 25; seed += 1) all.push(...checkModel(seed));
  for (const property of PROPERTIES) {
    it(`holds ${property} on every seed`, () => {
      expect(
        all.filter((v) => v.property === property),
        summarize(all, property),
      ).toEqual([]);
    });
  }
});
