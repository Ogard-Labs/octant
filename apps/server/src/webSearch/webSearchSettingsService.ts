import {
  ActorId,
  CorrelationId,
  EventId,
  LOCAL_HOST_ID,
  UtcTimestamp,
  WEB_SEARCH_CALL_ROUTED_EVENT_NAME,
  WEB_SEARCH_CALLS_AGGREGATE_TYPE,
  WEB_SEARCH_SETTINGS_AGGREGATE_TYPE,
  WEB_SEARCH_SETTINGS_EVENT_NAME,
  decodeWebSearchBackendId,
  type EventActor,
  type SetWebSearchKeyOutcome,
  type SetWebSearchKeyRequest,
  type SetWebSearchSettingsOutcome,
  type SetWebSearchSettingsRequest,
  type WebSearchBackendEntry,
  type WebSearchBackendState,
  type WebSearchCallRouted,
  type WebSearchSettings,
  type WebSearchSettingsView,
} from "@octant/contracts";
import {
  WEB_SEARCH_BACKEND_OFFERS,
  actsAsHostPerson,
  decideWebSearchSettings,
  eligibleWebSearchBackends,
  webSearchBackendEligibility,
  webSearchSettingsFromChatAddress,
  type PrincipalKind,
} from "@octant/domain";
import { Schema } from "effect";
import type { SearxngFetch } from "../chat/research/searxngClient";
import { SearxngEndpointRejected, validateSearxngEndpoint } from "../chat/research/searxngEndpoint";
import { readAggregateVersion } from "../persistence/chatProjection";
import type { Journal } from "../persistence/journal";
import type { SqliteConnection } from "../persistence/sqlitePort";
import {
  WEB_SEARCH_SETTINGS_AGGREGATE_ID,
  readSavedWebSearchSettings,
} from "../persistence/webSearchSettingsProjection";
import type { ProviderCredentialStore } from "../providers/credentialBrokerClient";
import {
  searchWebSearchBackends,
  type WebSearchAnswer,
  type WebSearchInput,
} from "./webSearchBackends";

const LOCAL_ACTOR_ID = "00000000-0000-4000-8000-000000000001";
const decodeActorId = Schema.decodeUnknownSync(ActorId);
const decodeCorrelationId = Schema.decodeUnknownSync(CorrelationId);
const decodeEventId = Schema.decodeUnknownSync(EventId);
const decodeTimestamp = Schema.decodeUnknownSync(UtcTimestamp);
const decodeAggregateId = Schema.decodeUnknownSync(Schema.UUID.pipe(Schema.brand("AggregateId")));

/** The id the entry migrated from Chat's SearXNG address keeps once saved. */
export const MIGRATED_SEARXNG_ENTRY_ID = decodeWebSearchBackendId(
  "00000000-0000-4000-8000-0000000000a1",
);

/** The one aggregate that records where each query went. */
const WEB_SEARCH_CALLS_AGGREGATE_ID = decodeAggregateId("00000000-0000-4000-8000-000000000035");

/** The broker's routes for search keys: everything this service asks of a key. */
export type WebSearchKeyStore = Pick<ProviderCredentialStore, "has" | "resolve" | "set" | "delete">;

export interface WebSearchSettingsServiceOptions {
  readonly connection: SqliteConnection;
  readonly journal: Journal;
  readonly clock: () => string;
  readonly uuid: () => string;
  /** The SearXNG address Chat settings hold, read until the person saves a list. */
  readonly readChatSearxngBaseUrl: () => string | undefined;
  /** The credential broker's web search namespace; absent, no keyed vendor can search. */
  readonly keys?: WebSearchKeyStore;
  readonly fetch?: SearxngFetch;
}

type AddressCheck =
  | { readonly kind: "valid"; readonly settings: WebSearchSettings }
  | { readonly kind: "invalid"; readonly message: string };

/** Every address in the list in the form Octant searches it, or why one is refused. */
function normalizeAddresses(settings: WebSearchSettings): AddressCheck {
  const backends: WebSearchBackendEntry[] = [];
  for (const entry of settings.backends) {
    if (entry.address === undefined) {
      backends.push(entry);
      continue;
    }
    try {
      backends.push({ ...entry, address: validateSearxngEndpoint(entry.address).toString() });
    } catch (error) {
      if (error instanceof SearxngEndpointRejected) {
        return {
          kind: "invalid",
          message:
            "A backend address must use HTTPS, or HTTP on a loopback address, with no credentials, query, or fragment.",
        };
      }
      throw error;
    }
  }
  return { kind: "valid", settings: { policy: settings.policy, backends } };
}

/**
 * The host's web search backends and data policy as a journaled setting. Each
 * change appends one event with who made it, when, and the settings before and
 * after; the projection is rebuilt from those events. Until the person saves a
 * list, the list reads from the SearXNG address Chat settings hold, so a host
 * that searched before the list existed searches the same way after.
 *
 * Keys live only in the credential broker, under each entry's credential
 * reference, which the host assigns: a client cannot point one entry at
 * another's key.
 */
export class WebSearchSettingsService {
  readonly #connection: SqliteConnection;
  readonly #journal: Journal;
  readonly #clock: () => string;
  readonly #uuid: () => string;
  readonly #readChatSearxngBaseUrl: () => string | undefined;
  readonly #keys: WebSearchKeyStore | undefined;
  readonly #fetch: SearxngFetch | undefined;
  /**
   * Entries whose vendor refused the stored key since it was last set. Held in
   * memory: after a restart the next search learns it again.
   */
  readonly #refusedKeys = new Set<string>();

  constructor(options: WebSearchSettingsServiceOptions) {
    this.#connection = options.connection;
    this.#journal = options.journal;
    this.#clock = options.clock;
    this.#uuid = options.uuid;
    this.#readChatSearxngBaseUrl = options.readChatSearxngBaseUrl;
    this.#keys = options.keys;
    this.#fetch = options.fetch;
  }

  read(): { readonly settings: WebSearchSettings; readonly source: "saved" | "migrated" } {
    const saved = readSavedWebSearchSettings(this.#connection);
    if (saved !== undefined) return { settings: saved, source: "saved" };
    return {
      settings: webSearchSettingsFromChatAddress(
        this.#readChatSearxngBaseUrl(),
        MIGRATED_SEARXNG_ENTRY_ID,
      ),
      source: "migrated",
    };
  }

  async view(): Promise<WebSearchSettingsView> {
    const { settings, source } = this.read();
    const states = await Promise.all(
      settings.backends.map(async (entry) => ({
        id: entry.id,
        state: await this.#state(entry, settings.policy),
      })),
    );
    return { settings, source, states };
  }

  async #state(
    entry: WebSearchBackendEntry,
    policy: WebSearchSettings["policy"],
  ): Promise<WebSearchBackendState> {
    const eligibility = webSearchBackendEligibility(entry, policy);
    if (eligibility.kind === "not-eligible") {
      return { kind: "not-eligible", reason: eligibility.reason };
    }
    if (!WEB_SEARCH_BACKEND_OFFERS[entry.kind].takesKey) return { kind: "ready" };
    if (this.#refusedKeys.has(String(entry.id))) return { kind: "needs-key" };
    const present =
      entry.credentialRef !== undefined &&
      (await this.#keys?.has(entry.credentialRef).catch(() => false)) === true;
    return present ? { kind: "ready" } : { kind: "needs-key" };
  }

  /** The entries a query may go to now, in the person's order. */
  eligible(): ReadonlyArray<WebSearchBackendEntry> {
    return eligibleWebSearchBackends(this.read().settings);
  }

  /**
   * Whether a query could go anywhere if Chat's SearXNG address were the one
   * given: a Chat settings save is checked against the address it is saving,
   * which reaches the list only while no list was saved.
   */
  readyWithChatAddress(searxngBaseUrl: string | undefined): boolean {
    const saved = readSavedWebSearchSettings(this.#connection);
    const settings =
      saved ?? webSearchSettingsFromChatAddress(searxngBaseUrl, MIGRATED_SEARXNG_ENTRY_ID);
    return eligibleWebSearchBackends(settings).length > 0;
  }

  /**
   * Search the eligible backends for one query, journaling where it went. The
   * list is read at the call, so a backend the policy stopped allowing while
   * the turn ran receives nothing.
   */
  async search(input: WebSearchInput): Promise<WebSearchAnswer> {
    const keys = this.#keys;
    return searchWebSearchBackends({
      backends: this.eligible(),
      search: input,
      ...(keys === undefined
        ? {}
        : {
            resolveKey: async (entry) =>
              entry.credentialRef === undefined || !(await keys.has(entry.credentialRef))
                ? undefined
                : await keys.resolve(entry.credentialRef),
          }),
      ...(this.#fetch === undefined ? {} : { fetch: this.#fetch }),
      onRouted: (routed) => {
        for (const failed of routed.failed) {
          if (failed.failure === "key-refused") this.#refusedKeys.add(String(failed.entryId));
        }
        if (routed.answeredBy !== undefined)
          this.#refusedKeys.delete(String(routed.answeredBy.entryId));
        this.#journalRouted(routed);
      },
    });
  }

  #journalRouted(routed: Omit<WebSearchCallRouted, "kind" | "routedAt">): void {
    const routedAt = decodeTimestamp(this.#clock());
    try {
      this.#journal.append({
        aggregate: {
          aggregateType: WEB_SEARCH_CALLS_AGGREGATE_TYPE,
          aggregateId: WEB_SEARCH_CALLS_AGGREGATE_ID,
        },
        expectedVersion: readAggregateVersion(
          this.#connection,
          WEB_SEARCH_CALLS_AGGREGATE_TYPE,
          WEB_SEARCH_CALLS_AGGREGATE_ID,
        ),
        events: [
          {
            eventId: decodeEventId(this.#uuid()),
            eventName: WEB_SEARCH_CALL_ROUTED_EVENT_NAME,
            eventVersion: 1,
            hostId: LOCAL_HOST_ID,
            correlationId: decodeCorrelationId(this.#uuid()),
            actor: { kind: "system" as const, actorId: decodeActorId(LOCAL_ACTOR_ID) },
            occurredAt: routedAt,
            payload: { kind: "web-search-call-routed", ...routed, routedAt },
          },
        ],
      });
    } catch {
      // The search already answered or failed; a record that cannot be written
      // must not turn that answer into an error for the model.
    }
  }

  async set(
    request: SetWebSearchSettingsRequest,
    principalKind: PrincipalKind,
    /** The paired device that asked. Absent, the change is the local person's. */
    actor?: EventActor,
  ): Promise<SetWebSearchSettingsOutcome> {
    const decision = decideWebSearchSettings({ principalKind, settings: request.settings });
    if (decision.kind === "refused") {
      return { kind: "refused", code: decision.code, message: decision.message };
    }
    const normalized = normalizeAddresses(decision.settings);
    if (normalized.kind === "invalid") {
      return { kind: "refused", code: "invalid-address", message: normalized.message };
    }
    const previous = this.read();
    const before = new Map(previous.settings.backends.map((entry) => [String(entry.id), entry]));
    const staleKeys: string[] = [];
    const next: WebSearchSettings = {
      policy: normalized.settings.policy,
      backends: normalized.settings.backends.map((entry) => {
        const { credentialRef: _ignored, ...rest } = entry;
        if (!WEB_SEARCH_BACKEND_OFFERS[entry.kind].takesKey) return rest;
        const prior = before.get(String(entry.id));
        // The host keeps an entry's reference; a new address or a new vendor
        // is a new key, as a model endpoint's new address is.
        const kept =
          prior?.credentialRef !== undefined &&
          prior.kind === entry.kind &&
          prior.address === entry.address
            ? prior.credentialRef
            : undefined;
        if (prior?.credentialRef !== undefined && kept === undefined) {
          staleKeys.push(prior.credentialRef);
        }
        return { ...rest, credentialRef: kept ?? this.#uuid() };
      }),
    };
    const kept = new Set(next.backends.map((entry) => String(entry.id)));
    for (const entry of previous.settings.backends) {
      if (!kept.has(String(entry.id)) && entry.credentialRef !== undefined) {
        staleKeys.push(entry.credentialRef);
      }
    }
    if (previous.source === "saved" && JSON.stringify(previous.settings) === JSON.stringify(next)) {
      return { kind: "saved", view: await this.view() };
    }
    const changedAt = decodeTimestamp(this.#clock());
    this.#journal.append({
      aggregate: {
        aggregateType: WEB_SEARCH_SETTINGS_AGGREGATE_TYPE,
        aggregateId: WEB_SEARCH_SETTINGS_AGGREGATE_ID,
      },
      expectedVersion: readAggregateVersion(
        this.#connection,
        WEB_SEARCH_SETTINGS_AGGREGATE_TYPE,
        WEB_SEARCH_SETTINGS_AGGREGATE_ID,
      ),
      events: [
        {
          eventId: decodeEventId(this.#uuid()),
          eventName: WEB_SEARCH_SETTINGS_EVENT_NAME,
          eventVersion: 1,
          hostId: LOCAL_HOST_ID,
          correlationId: decodeCorrelationId(this.#uuid()),
          actor: actor ?? { kind: "local-user" as const, actorId: decodeActorId(LOCAL_ACTOR_ID) },
          occurredAt: changedAt,
          payload: {
            kind: "web-search-settings-changed",
            previous: previous.settings,
            next,
            changedBy: actor?.kind === "remote-device" ? "remote-device" : "local-window",
            changedAt,
          },
        },
      ],
    });
    for (const credentialRef of staleKeys) {
      await this.#keys?.delete(credentialRef).catch(() => undefined);
    }
    return { kind: "saved", view: await this.view() };
  }

  async setKey(
    request: SetWebSearchKeyRequest,
    principalKind: PrincipalKind,
  ): Promise<SetWebSearchKeyOutcome> {
    if (!actsAsHostPerson(principalKind)) {
      return {
        kind: "refused",
        code: "unauthorized",
        message: "Only this host's own person can change web search.",
      };
    }
    const entry = this.read().settings.backends.find(
      (candidate) => String(candidate.id) === String(request.entryId),
    );
    if (entry === undefined) {
      return {
        kind: "refused",
        code: "unknown-entry",
        message: "Save the backend before its key.",
      };
    }
    if (!WEB_SEARCH_BACKEND_OFFERS[entry.kind].takesKey || entry.credentialRef === undefined) {
      return { kind: "refused", code: "key-not-taken", message: "This backend takes no key." };
    }
    if (this.#keys === undefined) {
      return {
        kind: "refused",
        code: "unavailable",
        message: "This host has no credential store for search keys.",
      };
    }
    try {
      if (request.key === undefined) await this.#keys.delete(entry.credentialRef);
      else await this.#keys.set(entry.credentialRef, request.key);
    } catch {
      return {
        kind: "refused",
        code: "unavailable",
        message: "The credential store did not keep the key.",
      };
    }
    this.#refusedKeys.delete(String(entry.id));
    return { kind: "saved", view: await this.view() };
  }
}
