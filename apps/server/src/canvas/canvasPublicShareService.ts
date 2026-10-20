import type { EventActor, UtcTimestamp } from "@octant/contracts";
import type { CanvasId, CanvasVersionId } from "@octant/contracts/canvas";
import type { CanvasExportLinkChoice } from "@octant/contracts/canvas-export";
import {
  CANVAS_PUBLIC_LINK_SETTINGS_AGGREGATE_TYPE,
  CANVAS_PUBLIC_LINK_SETTINGS_CHANGED,
  CANVAS_PUBLIC_SHARE_AGGREGATE_TYPE,
  CANVAS_PUBLIC_SHARE_DEFAULT_SERVICE_URL,
  CANVAS_PUBLIC_SHARE_PUBLISHED,
  CANVAS_PUBLIC_SHARE_REVOCATION_AGGREGATE_TYPE,
  CANVAS_PUBLIC_SHARE_REVOCATION_PENDING,
  CANVAS_PUBLIC_SHARE_REVOCATION_SETTLED,
  CANVAS_PUBLIC_SHARE_REVOKED,
  CANVAS_PUBLIC_SHARE_UPDATED,
  CANVAS_PUBLIC_SHARE_WIRE_VERSION,
  CanvasPublicLinkSettingsChanged,
  CanvasPublicSharePublished,
  CanvasPublicShareRecordRevoked,
  CanvasPublicShareRecordUpdated,
  CanvasPublicShareRevocationPending,
  CanvasPublicShareRevocationSettled,
  decodeCanvasPublicLinkSettings,
  decodeCanvasPublicLinkSettingsResult,
  decodeCanvasPublicShareList,
  decodeCanvasPublicShareRecord,
  decodeCanvasPublicShareRevokeResult,
  decodeCanvasPublicShareServiceUrl,
  type CanvasPublicLinkSettings,
  type CanvasPublicLinkSettingsCommand,
  type CanvasPublicLinkSettingsResult,
  type CanvasPublicShareDocument,
  type CanvasPublicShareId,
  type CanvasPublicShareList,
  type CanvasPublicShareRecord,
  type CanvasPublicShareRevokeResult,
  type CanvasPublicShareServiceUrl,
} from "@octant/contracts/canvas-public-share";
import { Schema } from "effect";
import type { EventRegistry } from "../persistence/eventRegistry";
import type { Journal } from "../persistence/journal";
import { ConcurrencyConflict } from "../persistence/journalErrors";
import { replayAggregateTypesInOrder } from "../persistence/journalHydration";
import type { CanvasPublicShareServicePort } from "./canvasPublicShareServicePort";

/**
 * The host's side of public links (docs/design/canvas-public-links.md).
 *
 * This holds the Settings switch, the record of every link, and the owner
 * secrets' references; the secrets themselves live in the credential broker
 * and never reach the journal, a window, or a log. Nothing here calls the
 * share service on its own initiative except to finish a revoke it already
 * promised: publishing is reached only from the Public link export
 * destination after the person approved a card.
 */

/** The owner secrets, through the credential broker's own namespace for them. */
export interface CanvasPublicShareSecretStore {
  readonly set: (credentialRef: string, secret: string) => Promise<void>;
  readonly resolve: (credentialRef: string) => Promise<string>;
  readonly delete: (credentialRef: string) => Promise<void>;
}

export interface CanvasPublicShareServiceDependencies {
  readonly journal: Pick<Journal, "append" | "replayAggregateType">;
  readonly service: CanvasPublicShareServicePort;
  /** Absent when this host has no credential broker; then nothing is published. */
  readonly secrets: CanvasPublicShareSecretStore | undefined;
  readonly uuid: () => string;
  readonly clock: () => UtcTimestamp;
  readonly actor: EventActor;
}

/** What a publish produced, for the export destination to report. */
export type CanvasPublicSharePublishOutcome =
  | { readonly kind: "published"; readonly record: CanvasPublicShareRecord }
  | {
      readonly kind: "refused";
      readonly code: "not-connected" | "refused" | "unavailable" | "too-large";
      readonly message: string;
    };

/** One link's place in the journal, with the secret's reference. */
interface HeldShare {
  readonly record: CanvasPublicShareRecord;
  readonly credentialRef: string;
  readonly version: number;
}

interface PendingRevocation {
  readonly publicShareId: CanvasPublicShareId;
  readonly serviceUrl: CanvasPublicShareServiceUrl;
  readonly credentialRef: string;
}

const SETTINGS_AGGREGATE_ID = "00000000-0000-4000-8000-0000000000c6";
/** A listing retries pending revocations at most this often. */
const RETRY_INTERVAL_MS = 60_000;

const decodePublished = Schema.decodeUnknownSync(CanvasPublicSharePublished);
const decodeUpdated = Schema.decodeUnknownSync(CanvasPublicShareRecordUpdated);
const decodeRevoked = Schema.decodeUnknownSync(CanvasPublicShareRecordRevoked);
const decodePending = Schema.decodeUnknownSync(CanvasPublicShareRevocationPending);
const decodeSettled = Schema.decodeUnknownSync(CanvasPublicShareRevocationSettled);
const decodeSettingsChanged = Schema.decodeUnknownSync(CanvasPublicLinkSettingsChanged);

export function registerCanvasPublicShareEvents(registry: EventRegistry): EventRegistry {
  return registry
    .register(CANVAS_PUBLIC_SHARE_PUBLISHED, 1, CanvasPublicSharePublished)
    .register(CANVAS_PUBLIC_SHARE_UPDATED, 1, CanvasPublicShareRecordUpdated)
    .register(CANVAS_PUBLIC_SHARE_REVOKED, 1, CanvasPublicShareRecordRevoked)
    .register(CANVAS_PUBLIC_SHARE_REVOCATION_PENDING, 1, CanvasPublicShareRevocationPending)
    .register(CANVAS_PUBLIC_SHARE_REVOCATION_SETTLED, 1, CanvasPublicShareRevocationSettled)
    .register(CANVAS_PUBLIC_LINK_SETTINGS_CHANGED, 1, CanvasPublicLinkSettingsChanged);
}

export class CanvasPublicShareService {
  readonly #dependencies: CanvasPublicShareServiceDependencies;
  #settings: CanvasPublicLinkSettings;
  /** Keyed by credential reference, which is also the record's aggregate id. */
  readonly #shares = new Map<string, HeldShare>();
  /** Keyed by credential reference; outlives the Canvas it came from. */
  readonly #pending = new Map<string, PendingRevocation>();
  readonly #pendingVersions = new Map<string, number>();
  #lastRetryMs = Number.NEGATIVE_INFINITY;
  #retrying: Promise<void> | undefined;

  constructor(dependencies: CanvasPublicShareServiceDependencies) {
    this.#dependencies = dependencies;
    this.#settings = decodeCanvasPublicLinkSettings({
      kind: "canvas-public-link-settings",
      enabled: false,
      serviceUrl: CANVAS_PUBLIC_SHARE_DEFAULT_SERVICE_URL,
      version: 0,
    });
    this.#hydrate();
  }

  settings(): CanvasPublicLinkSettings {
    return this.#settings;
  }

  /** Whether the Public link destination may be offered at all. */
  enabled(): boolean {
    return this.#settings.enabled;
  }

  /** Whether this host can keep an owner secret, without which nothing is published. */
  holdsSecrets(): boolean {
    return this.#dependencies.secrets !== undefined;
  }

  changeSettings(command: CanvasPublicLinkSettingsCommand): CanvasPublicLinkSettingsResult {
    if (command.expectedVersion !== this.#settings.version) {
      return refusedSettings("stale-version", "Public link settings changed since you read them.");
    }
    const changed = { enabled: command.enabled, serviceUrl: command.serviceUrl };
    try {
      this.#append(
        CANVAS_PUBLIC_LINK_SETTINGS_AGGREGATE_TYPE,
        SETTINGS_AGGREGATE_ID,
        this.#settings.version,
        CANVAS_PUBLIC_LINK_SETTINGS_CHANGED,
        changed,
      );
    } catch (error) {
      if (error instanceof ConcurrencyConflict) {
        return refusedSettings(
          "stale-version",
          "Public link settings changed since you read them.",
        );
      }
      throw error;
    }
    this.#settings = decodeCanvasPublicLinkSettings({
      kind: "canvas-public-link-settings",
      ...changed,
      version: this.#settings.version + 1,
      updatedAt: this.#dependencies.clock(),
    });
    return decodeCanvasPublicLinkSettingsResult({
      kind: "canvas-public-link-settings",
      settings: this.#settings,
    });
  }

  /** The one link a new publish of this Canvas would update, if it has one. */
  activeFor(canvasId: CanvasId): CanvasPublicShareRecord | undefined {
    return this.#activeHeld(canvasId)?.record;
  }

  /** What a window is shown for one Canvas. Revocations still owed are retried. */
  list(canvasId: CanvasId): CanvasPublicShareList {
    void this.retryPendingRevocations();
    const shares = [...this.#shares.values()]
      .filter((held) => String(held.record.canvasId) === String(canvasId))
      .map((held) => this.#withStatus(held))
      .sort((a, b) => b.publishedAt.localeCompare(a.publishedAt))
      .slice(0, 64);
    return decodeCanvasPublicShareList({
      schemaVersion: CANVAS_PUBLIC_SHARE_WIRE_VERSION,
      kind: "canvas-public-share-list",
      canvasId,
      enabled: this.#settings.enabled,
      serviceUrl: this.#settings.serviceUrl,
      shares,
    });
  }

  /**
   * Send an approved document to the service, as a new link or as an update of
   * this Canvas's active one. Called only by the export destination, after the
   * person approved the card that showed this exact document.
   */
  async publish(input: {
    readonly canvasId: CanvasId;
    readonly versionId: CanvasVersionId;
    readonly sequence: number;
    readonly document: CanvasPublicShareDocument;
    readonly choice: CanvasExportLinkChoice;
  }): Promise<CanvasPublicSharePublishOutcome> {
    if (!this.#settings.enabled) {
      return {
        kind: "refused",
        code: "not-connected",
        message: "Public links are off in Settings.",
      };
    }
    const secrets = this.#dependencies.secrets;
    if (secrets === undefined) {
      return {
        kind: "refused",
        code: "refused",
        message: "This Mac has no credential store to keep a link's owner secret in.",
      };
    }
    const active = this.#activeHeld(input.canvasId);
    if (active !== undefined) return this.#update(active, input, secrets);

    const serviceUrl = this.#settings.serviceUrl;
    const created = await this.#dependencies.service.create({
      serviceUrl,
      document: input.document,
      expiry: input.choice.expiry,
      ...(input.choice.password === undefined ? {} : { password: input.choice.password }),
    });
    if (created.kind !== "ok") return serviceRefusal(created);

    const credentialRef = this.#dependencies.uuid().toLowerCase();
    const ownerSecret = String(created.value.ownerSecret);
    try {
      await secrets.set(credentialRef, ownerSecret);
    } catch {
      // Without its secret the link could never be revoked from here, so it is
      // withdrawn at once rather than left at the service unowned.
      await this.#dependencies.service
        .revoke({ serviceUrl, shareId: created.value.shareId, ownerSecret })
        .catch(() => undefined);
      return {
        kind: "refused",
        code: "unavailable",
        message: "The link's owner secret could not be stored, so the link was withdrawn.",
      };
    }
    const now = this.#dependencies.clock();
    const record = decodeCanvasPublicShareRecord({
      publicShareId: created.value.shareId,
      canvasId: input.canvasId,
      url: created.value.url,
      serviceUrl,
      versionId: input.versionId,
      sequence: input.sequence,
      publishedAt: now,
      updatedAt: now,
      expiresAt: created.value.expiresAt,
      passwordProtected: input.choice.password !== undefined,
      status: "active",
    });
    this.#append(
      CANVAS_PUBLIC_SHARE_AGGREGATE_TYPE,
      credentialRef,
      0,
      CANVAS_PUBLIC_SHARE_PUBLISHED,
      {
        record,
        credentialRef,
      },
    );
    this.#shares.set(credentialRef, { record, credentialRef, version: 1 });
    return { kind: "published", record };
  }

  /**
   * Withdraw a link. The service deletes its copy and the link answers 410;
   * a service that cannot be reached leaves the revoke owed and retried.
   */
  async revoke(
    canvasId: CanvasId,
    publicShareId: CanvasPublicShareId,
  ): Promise<CanvasPublicShareRevokeResult> {
    const held = [...this.#shares.values()].find(
      (candidate) =>
        String(candidate.record.publicShareId) === String(publicShareId) &&
        String(candidate.record.canvasId) === String(canvasId),
    );
    if (held === undefined) {
      return decodeCanvasPublicShareRevokeResult({
        kind: "refused",
        code: "not-found",
        message: "That public link is not on this Mac.",
      });
    }
    if (held.record.status === "revoked") {
      return decodeCanvasPublicShareRevokeResult({ kind: "revoked", share: held.record });
    }
    this.#owe(held);
    const settled = await this.#settle(held.credentialRef);
    // The service was just tried; the next listing waits out the interval
    // rather than asking again at once.
    if (!settled) this.#lastRetryMs = Date.parse(this.#dependencies.clock());
    const current = this.#shares.get(held.credentialRef) ?? held;
    if (settled) {
      return decodeCanvasPublicShareRevokeResult({
        kind: "revoked",
        share: this.#withStatus(current),
      });
    }
    return decodeCanvasPublicShareRevokeResult({
      kind: "revoking",
      share: this.#withStatus(current),
      message: "The share service could not be reached. This Mac keeps trying to revoke the link.",
    });
  }

  /**
   * Before a purge erases these Canvases, owe a revoke for each link they hold.
   * The owed revoke names only the link, so it outlives the Canvas; the
   * attempt runs in the background and is retried until the service answers.
   */
  revokeForPurge(canvasIds: ReadonlyArray<string>): void {
    const purged = new Set(canvasIds.map(String));
    for (const held of this.#shares.values()) {
      if (!purged.has(String(held.record.canvasId))) continue;
      if (held.record.status === "revoked") continue;
      this.#owe(held);
    }
    this.#lastRetryMs = Number.NEGATIVE_INFINITY;
    void this.retryPendingRevocations();
  }

  /** Drop purged Canvases' records from memory; the journal rows are erased with them. */
  forget(canvasIds: ReadonlyArray<string>): void {
    const purged = new Set(canvasIds.map(String));
    for (const [key, held] of this.#shares) {
      if (purged.has(String(held.record.canvasId))) this.#shares.delete(key);
    }
  }

  /** Try every revoke still owed. Runs at start, after a purge, and on listings. */
  retryPendingRevocations(): Promise<void> {
    const nowMs = Date.parse(this.#dependencies.clock());
    if (this.#retrying !== undefined) return this.#retrying;
    if (this.#pending.size === 0 || nowMs - this.#lastRetryMs < RETRY_INTERVAL_MS) {
      return Promise.resolve();
    }
    this.#lastRetryMs = nowMs;
    const retrying = (async () => {
      // A Map visits keys added before the walk and skips ones deleted during
      // it, so settling (which deletes) needs no copy of the keys.
      for (const credentialRef of this.#pending.keys()) {
        await this.#settle(credentialRef);
      }
    })().finally(() => {
      this.#retrying = undefined;
    });
    this.#retrying = retrying;
    return retrying;
  }

  async #update(
    active: HeldShare,
    input: Parameters<CanvasPublicShareService["publish"]>[0],
    secrets: CanvasPublicShareSecretStore,
  ): Promise<CanvasPublicSharePublishOutcome> {
    let ownerSecret: string;
    try {
      ownerSecret = await secrets.resolve(active.credentialRef);
    } catch {
      return {
        kind: "refused",
        code: "unavailable",
        message: "This link's owner secret could not be read, so it cannot be updated.",
      };
    }
    const updated = await this.#dependencies.service.update({
      serviceUrl: active.record.serviceUrl,
      shareId: active.record.publicShareId,
      ownerSecret,
      document: input.document,
      expiry: input.choice.expiry,
      ...(input.choice.password === undefined ? {} : { password: input.choice.password }),
    });
    if (updated.kind !== "ok") return serviceRefusal(updated);
    const record = decodeCanvasPublicShareRecord({
      ...active.record,
      versionId: input.versionId,
      sequence: input.sequence,
      updatedAt: this.#dependencies.clock(),
      expiresAt: updated.value.expiresAt,
      passwordProtected: updated.value.passwordProtected,
      status: "active",
    });
    this.#append(
      CANVAS_PUBLIC_SHARE_AGGREGATE_TYPE,
      active.credentialRef,
      active.version,
      CANVAS_PUBLIC_SHARE_UPDATED,
      { record },
    );
    this.#shares.set(active.credentialRef, { ...active, record, version: active.version + 1 });
    return { kind: "published", record };
  }

  /** Record that a revoke is owed, once, before any attempt is made. */
  #owe(held: HeldShare): void {
    if (this.#pending.has(held.credentialRef)) return;
    const pending: PendingRevocation = {
      publicShareId: held.record.publicShareId,
      serviceUrl: held.record.serviceUrl,
      credentialRef: held.credentialRef,
    };
    this.#append(
      CANVAS_PUBLIC_SHARE_REVOCATION_AGGREGATE_TYPE,
      held.credentialRef,
      0,
      CANVAS_PUBLIC_SHARE_REVOCATION_PENDING,
      pending,
    );
    this.#pending.set(held.credentialRef, pending);
    this.#pendingVersions.set(held.credentialRef, 1);
  }

  /** Ask the service to delete one owed link. True once it is gone there. */
  async #settle(credentialRef: string): Promise<boolean> {
    const pending = this.#pending.get(credentialRef);
    if (pending === undefined) return true;
    const secrets = this.#dependencies.secrets;
    if (secrets === undefined) return false;
    let ownerSecret: string;
    try {
      ownerSecret = await secrets.resolve(credentialRef);
    } catch {
      return false;
    }
    const outcome = await this.#dependencies.service.revoke({
      serviceUrl: pending.serviceUrl,
      shareId: pending.publicShareId,
      ownerSecret,
    });
    // The service answers an unknown id as it answers a wrong secret, and a
    // link past its tombstone is unknown, so either refusal means it is gone.
    const gone =
      outcome.kind === "ok" ||
      (outcome.kind === "refused" &&
        (outcome.code === "gone" ||
          outcome.code === "not-found" ||
          outcome.code === "unauthorized"));
    if (!gone) return false;
    if (!this.#pending.has(credentialRef)) return true;
    const revokedAt = this.#dependencies.clock();
    const held = this.#shares.get(credentialRef);
    if (held !== undefined) {
      this.#append(
        CANVAS_PUBLIC_SHARE_AGGREGATE_TYPE,
        credentialRef,
        held.version,
        CANVAS_PUBLIC_SHARE_REVOKED,
        { publicShareId: held.record.publicShareId, canvasId: held.record.canvasId, revokedAt },
      );
      this.#shares.set(credentialRef, {
        ...held,
        version: held.version + 1,
        record: { ...held.record, status: "revoked", revokedAt },
      });
    }
    this.#append(
      CANVAS_PUBLIC_SHARE_REVOCATION_AGGREGATE_TYPE,
      credentialRef,
      this.#pendingVersions.get(credentialRef) ?? 1,
      CANVAS_PUBLIC_SHARE_REVOCATION_SETTLED,
      { publicShareId: pending.publicShareId },
    );
    this.#pending.delete(credentialRef);
    this.#pendingVersions.delete(credentialRef);
    await secrets.delete(credentialRef).catch(() => undefined);
    return true;
  }

  #activeHeld(canvasId: CanvasId): HeldShare | undefined {
    for (const held of this.#shares.values()) {
      if (String(held.record.canvasId) !== String(canvasId)) continue;
      if (this.#withStatus(held).status === "active") return held;
    }
    return undefined;
  }

  /** A record's status now: revoked and owed revokes first, then expiry by the clock. */
  #withStatus(held: HeldShare): CanvasPublicShareRecord {
    if (held.record.status === "revoked") return held.record;
    if (this.#pending.has(held.credentialRef)) return { ...held.record, status: "revoking" };
    const expiresAt = held.record.expiresAt;
    if (expiresAt !== null && Date.parse(expiresAt) <= Date.parse(this.#dependencies.clock())) {
      return { ...held.record, status: "expired" };
    }
    return { ...held.record, status: "active" };
  }

  #append(
    aggregateType: string,
    aggregateId: string,
    expectedVersion: number,
    eventName: string,
    payload: unknown,
  ): void {
    this.#dependencies.journal.append({
      aggregate: { aggregateType, aggregateId },
      expectedVersion,
      events: [
        {
          eventId: this.#dependencies.uuid(),
          eventName,
          eventVersion: 1,
          correlationId: this.#dependencies.uuid(),
          actor: this.#dependencies.actor,
          occurredAt: this.#dependencies.clock(),
          payload,
        },
      ],
    });
  }

  #hydrate(): void {
    for (const envelope of replayAggregateTypesInOrder(this.#dependencies.journal, [
      CANVAS_PUBLIC_LINK_SETTINGS_AGGREGATE_TYPE,
      CANVAS_PUBLIC_SHARE_AGGREGATE_TYPE,
      CANVAS_PUBLIC_SHARE_REVOCATION_AGGREGATE_TYPE,
    ])) {
      try {
        const key = String(envelope.aggregateId);
        switch (envelope.eventName) {
          case CANVAS_PUBLIC_LINK_SETTINGS_CHANGED: {
            const changed = decodeSettingsChanged(envelope.payload);
            this.#settings = decodeCanvasPublicLinkSettings({
              kind: "canvas-public-link-settings",
              enabled: changed.enabled,
              serviceUrl: decodeCanvasPublicShareServiceUrl(changed.serviceUrl),
              version: envelope.aggregateVersion,
              updatedAt: envelope.occurredAt,
            });
            break;
          }
          case CANVAS_PUBLIC_SHARE_PUBLISHED: {
            const published = decodePublished(envelope.payload);
            this.#shares.set(key, {
              record: published.record,
              credentialRef: published.credentialRef,
              version: envelope.aggregateVersion,
            });
            break;
          }
          case CANVAS_PUBLIC_SHARE_UPDATED: {
            const held = this.#shares.get(key);
            if (held === undefined) break;
            const { record } = decodeUpdated(envelope.payload);
            this.#shares.set(key, { ...held, record, version: envelope.aggregateVersion });
            break;
          }
          case CANVAS_PUBLIC_SHARE_REVOKED: {
            const held = this.#shares.get(key);
            if (held === undefined) break;
            const { revokedAt } = decodeRevoked(envelope.payload);
            this.#shares.set(key, {
              ...held,
              record: { ...held.record, status: "revoked", revokedAt },
              version: envelope.aggregateVersion,
            });
            break;
          }
          case CANVAS_PUBLIC_SHARE_REVOCATION_PENDING: {
            const pending = decodePending(envelope.payload);
            this.#pending.set(key, pending);
            this.#pendingVersions.set(key, envelope.aggregateVersion);
            break;
          }
          case CANVAS_PUBLIC_SHARE_REVOCATION_SETTLED: {
            decodeSettled(envelope.payload);
            this.#pending.delete(key);
            this.#pendingVersions.delete(key);
            break;
          }
          default:
            break;
        }
      } catch {
        // The journal stays authoritative; a frame that no longer decodes is
        // not rewritten into a link nobody published.
      }
    }
  }
}

function refusedSettings(
  reason: "malformed" | "stale-version" | "unauthorized" | "unavailable",
  message: string,
): CanvasPublicLinkSettingsResult {
  return decodeCanvasPublicLinkSettingsResult({
    kind: "canvas-public-link-settings-refused",
    reason,
    message,
  });
}

function serviceRefusal(
  outcome: Exclude<
    Awaited<ReturnType<CanvasPublicShareServicePort["create"]>>,
    { readonly kind: "ok" }
  >,
): CanvasPublicSharePublishOutcome {
  if (outcome.kind === "unreachable") {
    return {
      kind: "refused",
      code: "unavailable",
      message: "The share service could not be reached.",
    };
  }
  if (outcome.code === "too-large") {
    return {
      kind: "refused",
      code: "too-large",
      message: "The share service refused a Canvas this large.",
    };
  }
  if (outcome.code === "rate-limited") {
    return {
      kind: "refused",
      code: "unavailable",
      message: "The share service asked to wait. Try again in a minute.",
    };
  }
  return { kind: "refused", code: "refused", message: "The share service refused this link." };
}
