import {
  ActorId,
  CorrelationId,
  EventId,
  LOCAL_HOST_ID,
  UtcTimestamp,
  WEB_SEARCH_SETTINGS_AGGREGATE_TYPE,
  WEB_SEARCH_SETTINGS_EVENT_NAME,
  decodeWebSearchBackendId,
  type EventActor,
  type SetWebSearchSettingsOutcome,
  type SetWebSearchSettingsRequest,
  type WebSearchBackendEntry,
  type WebSearchSettings,
  type WebSearchSettingsView,
} from "@octant/contracts";
import {
  decideWebSearchSettings,
  eligibleWebSearchBackends,
  webSearchBackendEligibility,
  webSearchSettingsFromChatAddress,
  type PrincipalKind,
} from "@octant/domain";
import { Schema } from "effect";
import { SearxngEndpointRejected, validateSearxngEndpoint } from "../chat/research/searxngEndpoint";
import { readAggregateVersion } from "../persistence/chatProjection";
import type { Journal } from "../persistence/journal";
import type { SqliteConnection } from "../persistence/sqlitePort";
import {
  WEB_SEARCH_SETTINGS_AGGREGATE_ID,
  readSavedWebSearchSettings,
} from "../persistence/webSearchSettingsProjection";

const LOCAL_ACTOR_ID = "00000000-0000-4000-8000-000000000001";
const decodeActorId = Schema.decodeUnknownSync(ActorId);
const decodeCorrelationId = Schema.decodeUnknownSync(CorrelationId);
const decodeEventId = Schema.decodeUnknownSync(EventId);
const decodeTimestamp = Schema.decodeUnknownSync(UtcTimestamp);

/** The id the entry migrated from Chat's SearXNG address keeps once saved. */
export const MIGRATED_SEARXNG_ENTRY_ID = decodeWebSearchBackendId(
  "00000000-0000-4000-8000-0000000000a1",
);

export interface WebSearchSettingsServiceOptions {
  readonly connection: SqliteConnection;
  readonly journal: Journal;
  readonly clock: () => string;
  readonly uuid: () => string;
  /** The SearXNG address Chat settings hold, read until the person saves a list. */
  readonly readChatSearxngBaseUrl: () => string | undefined;
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
 */
export class WebSearchSettingsService {
  readonly #connection: SqliteConnection;
  readonly #journal: Journal;
  readonly #clock: () => string;
  readonly #uuid: () => string;
  readonly #readChatSearxngBaseUrl: () => string | undefined;

  constructor(options: WebSearchSettingsServiceOptions) {
    this.#connection = options.connection;
    this.#journal = options.journal;
    this.#clock = options.clock;
    this.#uuid = options.uuid;
    this.#readChatSearxngBaseUrl = options.readChatSearxngBaseUrl;
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

  view(): WebSearchSettingsView {
    const { settings, source } = this.read();
    return {
      settings,
      source,
      states: settings.backends.map((entry) => {
        const eligibility = webSearchBackendEligibility(entry, settings.policy);
        return {
          id: entry.id,
          state:
            eligibility.kind === "eligible"
              ? { kind: "ready" as const }
              : { kind: "not-eligible" as const, reason: eligibility.reason },
        };
      }),
    };
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

  set(
    request: SetWebSearchSettingsRequest,
    principalKind: PrincipalKind,
    /** The paired device that asked. Absent, the change is the local person's. */
    actor?: EventActor,
  ): SetWebSearchSettingsOutcome {
    const decision = decideWebSearchSettings({ principalKind, settings: request.settings });
    if (decision.kind === "refused") {
      return { kind: "refused", code: decision.code, message: decision.message };
    }
    const normalized = normalizeAddresses(decision.settings);
    if (normalized.kind === "invalid") {
      return { kind: "refused", code: "invalid-address", message: normalized.message };
    }
    const previous = this.read();
    if (
      previous.source === "saved" &&
      JSON.stringify(previous.settings) === JSON.stringify(normalized.settings)
    ) {
      return { kind: "saved", view: this.view() };
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
            next: normalized.settings,
            changedBy: actor?.kind === "remote-device" ? "remote-device" : "local-window",
            changedAt,
          },
        },
      ],
    });
    return { kind: "saved", view: this.view() };
  }
}
