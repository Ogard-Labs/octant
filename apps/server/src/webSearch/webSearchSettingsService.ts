import { authorizeSandboxHostRequest, sandboxToolPolicy } from "../process/sandboxRuntimePolicy";
import { createPinnedFetch } from "../harness/nativeHarnessWebFetch";
import {
  ActorId,
  AggregateId,
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
  WebSearchSettings,
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
import { Option, Schema } from "effect";
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
const decodeAggregateIdOption = Schema.decodeUnknownOption(AggregateId);
const decodeToolCallIdOption = Schema.decodeUnknownOption(
  Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(255)),
);

/**
 * Field by field, not by serialized text: the saved list comes back from the
 * projection in the schema's key order, and a rebuilt entry carries its
 * credential reference last, so equal lists serialize differently.
 */
const sameWebSearchSettings = Schema.equivalence(WebSearchSettings);

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
  /** Where a key the broker would not delete is reported; never given the key. */
  readonly log?: (line: string) => void;
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
  readonly #log: (line: string) => void;
  /**
   * Saves of the list and of a key, one at a time: a key stored while the
   * list moved its entry to a new reference would otherwise sit in the broker
   * under a reference nothing names.
   */
  #changes: Promise<unknown> = Promise.resolve();
  /**
   * Entries whose vendor refused the stored key since it was last set. Held in
   * memory: after a restart the next search learns it again.
   */
  readonly #refusedKeys = new Set<string>();
  /**
   * Credential references the broker last said hold a key. A keyed entry
   * counts toward offering `web-search` only while its key is here: offering
   * a tool whose every backend would answer Needs key promises a search that
   * cannot run. Learned when the host starts and on every read of the page.
   */
  readonly #storedKeys = new Set<string>();

  constructor(options: WebSearchSettingsServiceOptions) {
    this.#connection = options.connection;
    this.#journal = options.journal;
    this.#clock = options.clock;
    this.#uuid = options.uuid;
    this.#readChatSearxngBaseUrl = options.readChatSearxngBaseUrl;
    this.#keys = options.keys;
    this.#fetch = options.fetch;
    this.#log = options.log ?? ((line) => console.warn(line));
    if (this.#keys !== undefined) void this.view().catch(() => undefined);
  }

  /** Whether the entry can search now: it takes no key, or its key is stored. */
  #keyReady(entry: WebSearchBackendEntry): boolean {
    if (!WEB_SEARCH_BACKEND_OFFERS[entry.kind].takesKey) return true;
    return entry.credentialRef !== undefined && this.#storedKeys.has(entry.credentialRef);
  }

  #oneAtATime<T>(change: () => Promise<T>): Promise<T> {
    const run = this.#changes.then(change, change);
    this.#changes = run.catch(() => undefined);
    return run;
  }

  /** Delete a key nothing names any more, and say so when the broker would not. */
  async #deleteKey(credentialRef: string): Promise<void> {
    try {
      await this.#keys?.delete(credentialRef);
    } catch {
      this.#log(
        `[web-search] the credential broker did not delete the key under reference ${credentialRef}; it is no longer used.`,
      );
    }
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
    if (entry.credentialRef !== undefined) {
      if (present) this.#storedKeys.add(entry.credentialRef);
      else this.#storedKeys.delete(entry.credentialRef);
    }
    return present ? { kind: "ready" } : { kind: "needs-key" };
  }

  /** The entries a query may go to now, in the person's order. */
  eligible(): ReadonlyArray<WebSearchBackendEntry> {
    return eligibleWebSearchBackends(this.read().settings).filter((entry) => this.#keyReady(entry));
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
    return eligibleWebSearchBackends(settings).some((entry) => this.#keyReady(entry));
  }

  /**
   * Search the eligible backends for one query, journaling where it went. The
   * list is read at the call, so a backend the policy stopped allowing while
   * the turn ran receives nothing.
   */
  async search(input: WebSearchInput): Promise<WebSearchAnswer> {
    const keys = this.#keys;
    const searchFetch: SearxngFetch | undefined =
      sandboxToolPolicy() === undefined
        ? this.#fetch
        : async (target, init) => {
            const request = new Request(target, init);
            const url = new URL(request.url);
            authorizeSandboxHostRequest(url);
            if (request.method !== "GET" && request.method !== "POST")
              throw new Error("Unsupported search transport method");
            return createPinnedFetch()(url, {
              signal: request.signal,
              headers: Object.fromEntries(request.headers.entries()),
              redirect: "manual",
              ...(request.method === "POST"
                ? { body: new Uint8Array(await request.arrayBuffer()) }
                : {}),
            });
          };
    return searchWebSearchBackends({
      backends: this.eligible(),
      search: input,
      ...(keys === undefined
        ? {}
        : {
            resolveKey: async (entry) => {
              if (entry.credentialRef === undefined) return undefined;
              if (!(await keys.has(entry.credentialRef))) {
                this.#storedKeys.delete(entry.credentialRef);
                return undefined;
              }
              return await keys.resolve(entry.credentialRef);
            },
          }),
      ...(searchFetch === undefined ? {} : { fetch: searchFetch }),
      onRouted: (routed) => {
        for (const failed of routed.failed) {
          if (failed.failure === "key-refused") this.#refusedKeys.add(String(failed.entryId));
        }
        if (routed.answeredBy !== undefined)
          this.#refusedKeys.delete(String(routed.answeredBy.entryId));
        this.#journalRouted(routed, input);
      },
    });
  }

  #journalRouted(
    routed: Omit<WebSearchCallRouted, "kind" | "routedAt" | "threadId" | "toolCallId">,
    call: Pick<WebSearchInput, "threadId" | "toolCallId">,
  ): void {
    const routedAt = decodeTimestamp(this.#clock());
    const threadId =
      call.threadId === undefined
        ? undefined
        : Option.getOrUndefined(decodeAggregateIdOption(call.threadId));
    const toolCallId =
      call.toolCallId === undefined
        ? undefined
        : Option.getOrUndefined(decodeToolCallIdOption(call.toolCallId));
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
            payload: {
              kind: "web-search-call-routed",
              ...(threadId === undefined ? {} : { threadId }),
              ...(toolCallId === undefined ? {} : { toolCallId }),
              ...routed,
              routedAt,
            },
          },
        ],
      });
    } catch {
      // The search already answered or failed; a record that cannot be written
      // must not turn that answer into an error for the model.
    }
  }

  set(
    request: SetWebSearchSettingsRequest,
    principalKind: PrincipalKind,
    /** The paired device that asked. Absent, the change is the local person's. */
    actor?: EventActor,
  ): Promise<SetWebSearchSettingsOutcome> {
    return this.#oneAtATime(() => this.#set(request, principalKind, actor));
  }

  async #set(
    request: SetWebSearchSettingsRequest,
    principalKind: PrincipalKind,
    actor: EventActor | undefined,
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
        const prior = before.get(String(entry.id));
        // An entry that keeps its id but moves to a kind that takes no key,
        // such as a vendor switched to SearXNG, still leaves its old key in the
        // broker; the id-based sweep below does not see it, since the id stays.
        if (!WEB_SEARCH_BACKEND_OFFERS[entry.kind].takesKey) {
          if (prior?.credentialRef !== undefined) staleKeys.push(prior.credentialRef);
          return rest;
        }
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
    if (previous.source === "saved" && sameWebSearchSettings(previous.settings, next)) {
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
      this.#storedKeys.delete(credentialRef);
      await this.#deleteKey(credentialRef);
    }
    return { kind: "saved", view: await this.view() };
  }

  setKey(
    request: SetWebSearchKeyRequest,
    principalKind: PrincipalKind,
  ): Promise<SetWebSearchKeyOutcome> {
    return this.#oneAtATime(() => this.#setKey(request, principalKind));
  }

  async #setKey(
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
    // Saves run one at a time, but the list is the journal's: if the entry no
    // longer names this reference, the key just stored is no one's.
    const current = this.read().settings.backends.find(
      (candidate) => String(candidate.id) === String(request.entryId),
    );
    if (request.key === undefined) this.#storedKeys.delete(entry.credentialRef);
    else this.#storedKeys.add(entry.credentialRef);
    if (request.key !== undefined && current?.credentialRef !== entry.credentialRef) {
      this.#storedKeys.delete(entry.credentialRef);
      await this.#deleteKey(entry.credentialRef);
      return {
        kind: "refused",
        code: "unknown-entry",
        message: "The backend changed while its key was saved. Save the key again.",
      };
    }
    this.#refusedKeys.delete(String(entry.id));
    return { kind: "saved", view: await this.view() };
  }
}
