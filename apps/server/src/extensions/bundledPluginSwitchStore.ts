import {
  AggregateId,
  AggregateVersion,
  EventActor,
  EventId,
  EventName,
  UtcTimestamp,
  type EventActor as EventActorValue,
} from "@octant/contracts";
import {
  BUNDLED_PLUGIN_SWITCH_AGGREGATE,
  BUNDLED_PLUGIN_SWITCH_EVENT_NAMES,
  decodeBundledPluginSwitched,
} from "@octant/contracts/extension-events";
import type {
  ExtensionActivationState,
  ExtensionPackageManifest,
  ExtensionPackageState,
} from "@octant/contracts/extensions";
import { resolveExtensionActivation } from "@octant/plugin-host/activation";
import {
  SWITCHABLE_FIRST_PARTY_PLUGINS,
  switchableFirstPartyPlugin,
} from "@octant/plugin-host/first-party-plugins";
import { Schema } from "effect";
import { readBundledPluginSwitch } from "../persistence/bundledPluginSwitchProjection";
import type { Journal } from "../persistence/journal";
import { ConcurrencyConflict } from "../persistence/journalErrors";
import type { SqliteConnection } from "../persistence/sqlitePort";

const decodeActor = Schema.decodeUnknownSync(EventActor);
const decodeAggregateId = Schema.decodeUnknownSync(AggregateId);
const decodeAggregateVersion = Schema.decodeUnknownSync(AggregateVersion);
const decodeEventId = Schema.decodeUnknownSync(EventId);
const decodeEventName = Schema.decodeUnknownSync(EventName);
const decodeTimestamp = Schema.decodeUnknownSync(UtcTimestamp);

export type BundledPluginSwitchResult =
  | { readonly status: "recorded" }
  | { readonly status: "stale" }
  | { readonly status: "refused" };

export interface BundledPluginSwitchStoreOptions {
  readonly journal: Pick<Journal, "append">;
  readonly connection: SqliteConnection;
  readonly uuid: () => string;
  readonly clock: () => string;
  readonly actor: EventActorValue;
}

/**
 * The on/off switches of the plugins built into Octant. These plugins ship
 * with the app, so nothing here installs, verifies, or removes files: the
 * installed-package store, which assumes package files on disk, never holds
 * them. The journal holds each switch; the projection answers, and a plugin
 * nobody switched is on.
 */
export class BundledPluginSwitchStore {
  readonly #journal: Pick<Journal, "append">;
  readonly #connection: SqliteConnection;
  readonly #uuid: () => string;
  readonly #clock: () => string;
  readonly #actor: EventActorValue;

  constructor(options: BundledPluginSwitchStoreOptions) {
    this.#journal = options.journal;
    this.#connection = options.connection;
    this.#uuid = options.uuid;
    this.#clock = options.clock;
    this.#actor = decodeActor(options.actor);
  }

  /** Whether this extension id names a plugin built into Octant with a switch. */
  holds(extensionId: string): boolean {
    return switchableFirstPartyPlugin(extensionId) !== undefined;
  }

  /** One installed, trusted package row per switchable bundled plugin. */
  packageStates(): ReadonlyArray<ExtensionPackageState> {
    return SWITCHABLE_FIRST_PARTY_PLUGINS.map((manifest) =>
      bundledPackageState(
        manifest,
        readBundledPluginSwitch(this.#connection, String(manifest.extensionId)),
      ),
    );
  }

  /**
   * Records the person's switch. `expectedStateVersion` must be the version
   * the person saw, as for an installed package's desired state; a switch
   * already in the asked position records nothing. `actor` is who switched
   * it, resolved from the authenticated principal; absent means the person at
   * this host.
   */
  setDesired(
    command: {
      readonly extensionId: string;
      readonly expectedStateVersion: number;
      readonly desired: boolean;
    },
    actor: EventActorValue = this.#actor,
  ): BundledPluginSwitchResult {
    if (!this.holds(command.extensionId)) return { status: "refused" };
    const current = readBundledPluginSwitch(this.#connection, command.extensionId);
    if (current.stateVersion !== command.expectedStateVersion) return { status: "stale" };
    if (current.desired === command.desired) return { status: "recorded" };
    const eventId = decodeEventId(this.#uuid());
    try {
      this.#journal.append({
        aggregate: {
          aggregateType: BUNDLED_PLUGIN_SWITCH_AGGREGATE,
          aggregateId: decodeAggregateId(command.extensionId),
        },
        expectedVersion: decodeAggregateVersion(command.expectedStateVersion),
        events: [
          {
            eventId,
            eventName: decodeEventName(BUNDLED_PLUGIN_SWITCH_EVENT_NAMES.switched),
            eventVersion: 1,
            correlationId: eventId,
            actor,
            occurredAt: decodeTimestamp(this.#clock()),
            payload: decodeBundledPluginSwitched({
              extensionId: command.extensionId,
              desired: command.desired,
            }),
          },
        ],
      });
    } catch (error) {
      if (error instanceof ConcurrencyConflict) return { status: "stale" };
      throw error;
    }
    return { status: "recorded" };
  }
}

function bundledPackageState(
  manifest: ExtensionPackageManifest,
  switched: { readonly desired: boolean; readonly stateVersion: number },
): ExtensionPackageState {
  // The code ships with the app and its source is reviewed, so the only fact
  // a person changes is the plugin switch; each component follows it.
  const activation: ExtensionActivationState = {
    installed: true,
    trusted: true,
    pluginDesired: switched.desired,
    componentDesired: true,
    compatible: true,
    policyAllowed: true,
    quarantined: false,
    draining: false,
    broken: false,
    unavailable: false,
    interrupted: false,
    waiting: false,
  };
  const effectiveState = resolveExtensionActivation({
    ...activation,
    hostAllowed: true,
    modeAllowed: true,
    projectAllowed: true,
    threadAllowed: true,
    catalogCurrent: true,
  });
  return {
    extensionId: manifest.extensionId,
    packageId: manifest.packageId,
    slug: manifest.slug,
    displayName: manifest.displayName,
    stateVersion: decodeAggregateVersion(switched.stateVersion),
    version: manifest.version,
    digest: manifest.digest,
    source: manifest.source,
    compatibility: manifest.compatibility,
    activation,
    components: manifest.components.map((component) => ({
      component,
      activation,
      effectiveState,
    })),
    diagnostics: [],
  };
}
