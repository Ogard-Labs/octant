import {
  BROWSER_PROFILE_EVENT_NAMES,
  AggregateId,
  AggregateVersion,
  CorrelationId,
  EventActor,
  EventId,
  EventName,
  UtcTimestamp,
  decodeBrowserProfileCleared,
  decodeBrowserProfilesResult,
  type BrowserProfileClearScope,
  type BrowserProfilesCommand,
  type BrowserProfilesResult,
  type BrowserProfileSummary,
  type EventActor as EventActorValue,
  type Project,
  type ProjectId,
  type StoredBrowserProfile,
} from "@octant/contracts";
import { Schema } from "effect";
import type { Journal } from "../persistence/journal";
import type { BrowserRuntimePort } from "./browserRuntimePort";

const decodeAggregateId = Schema.decodeUnknownSync(AggregateId);
const decodeAggregateVersion = Schema.decodeUnknownSync(AggregateVersion);
const decodeCorrelationId = Schema.decodeUnknownSync(CorrelationId);
const decodeEventActor = Schema.decodeUnknownSync(EventActor);
const decodeEventId = Schema.decodeUnknownSync(EventId);
const decodeEventName = Schema.decodeUnknownSync(EventName);
const decodeTimestamp = Schema.decodeUnknownSync(UtcTimestamp);

export const BROWSER_PROFILE_AGGREGATE = "browser-profile";

/** Who is asking. Only the person at a local window manages a profile. */
export type BrowserProfilesCaller = "local-window" | "remote-device";

export interface BrowserProfileServiceOptions {
  readonly runtime: BrowserRuntimePort;
  readonly readProject: (projectId: ProjectId) => Project | undefined;
  readonly journal: Pick<Journal, "append">;
  readonly actor: EventActorValue;
  /**
   * Closes whatever pages of this profile the server itself tracks. The desktop
   * app closes its own views too; this makes the server's records agree at once
   * instead of on the next poll.
   */
  readonly closePages: (profile: StoredBrowserProfile) => Promise<void>;
  readonly uuid: () => string;
  readonly clock: () => string;
}

/**
 * The profiles the host stores, listed and cleared.
 *
 * A profile holds sign-ins, so listing and clearing are the person's: a paired
 * device is refused. The service never reads a cookie; it knows a profile by
 * its name and how much disk it occupies, and the journal records that a profile
 * was cleared and how, nothing more.
 */
export class BrowserProfileService {
  readonly #options: BrowserProfileServiceOptions;

  constructor(options: BrowserProfileServiceOptions) {
    this.#options = options;
  }

  async execute(
    caller: BrowserProfilesCaller,
    command: BrowserProfilesCommand,
  ): Promise<BrowserProfilesResult> {
    if (caller !== "local-window") {
      return refused("profile-not-local", "Browser profiles are managed only on this Mac.");
    }
    const store = this.#options.runtime.profiles;
    if (store === undefined || (await this.#options.runtime.nativeAvailable?.()) !== true) {
      return refused(
        "profile-unavailable",
        "Browser profiles are kept by the Octant app, which is not running.",
      );
    }
    if (command.kind === "list") return this.#list(store);
    return this.#clear(store, command.profile, command.scope);
  }

  async #list(store: NonNullable<BrowserRuntimePort["profiles"]>): Promise<BrowserProfilesResult> {
    let stored;
    try {
      stored = await store.list();
    } catch {
      return refused("profile-unavailable", "The Browser profiles could not be read.");
    }
    const summaries: BrowserProfileSummary[] = [];
    // The Personal profile is always listed, so a person can see it exists
    // before they have signed in to anything.
    const personal = stored.find((entry) => entry.profile.kind === "personal");
    summaries.push({
      profile: { kind: "personal" },
      label: "Personal",
      sizeBytes: personal?.sizeBytes ?? 0,
    });
    for (const entry of stored) {
      if (entry.profile.kind !== "project") continue;
      summaries.push({
        profile: entry.profile,
        label: this.#projectLabel(entry.profile.projectId),
        sizeBytes: entry.sizeBytes,
      });
    }
    return decodeBrowserProfilesResult({ kind: "browser-profiles", profiles: summaries });
  }

  async #clear(
    store: NonNullable<BrowserRuntimePort["profiles"]>,
    profile: StoredBrowserProfile,
    scope: BrowserProfileClearScope,
  ): Promise<BrowserProfilesResult> {
    try {
      await this.#options.closePages(profile);
      await store.clear(profile, scope);
    } catch {
      return refused("profile-unavailable", "The profile could not be cleared.");
    }
    this.#journalCleared(profile, scope);
    return decodeBrowserProfilesResult({ kind: "browser-profile-cleared", profile, scope });
  }

  /**
   * Removes a Project's profile store with the Project's other data, when the
   * person's confirmed purge erases that Project. It closes the profile's pages,
   * clears everything the desktop app kept, and journals the clear like a sign
   * out. Without the desktop app running there is nothing to clear here; the
   * store stays and Settings lists it as a Project that no longer exists, where
   * the person can sign out of it.
   */
  async eraseProject(projectId: ProjectId): Promise<void> {
    const store = this.#options.runtime.profiles;
    if (store === undefined || (await this.#options.runtime.nativeAvailable?.()) !== true) return;
    const profile: StoredBrowserProfile = { kind: "project", projectId };
    try {
      await this.#options.closePages(profile);
      await store.clear(profile, "all");
      this.#journalCleared(profile, "all");
    } catch {
      // The purge itself is done; a store that would not clear stays listed.
    }
  }

  #projectLabel(projectId: ProjectId): string {
    const project = this.#options.readProject(projectId);
    return project === undefined ? "A Project that no longer exists" : project.name;
  }

  #journalCleared(profile: StoredBrowserProfile, scope: BrowserProfileClearScope): void {
    this.#options.journal.append({
      aggregate: {
        aggregateType: BROWSER_PROFILE_AGGREGATE,
        aggregateId: decodeAggregateId(this.#options.uuid()),
      },
      expectedVersion: decodeAggregateVersion(0),
      events: [
        {
          eventId: decodeEventId(this.#options.uuid()),
          eventName: decodeEventName(BROWSER_PROFILE_EVENT_NAMES.cleared),
          eventVersion: 1,
          correlationId: decodeCorrelationId(this.#options.uuid()),
          actor: decodeEventActor(this.#options.actor),
          occurredAt: decodeTimestamp(this.#options.clock()),
          payload: decodeBrowserProfileCleared({
            kind: "browser-profile-cleared",
            profile,
            scope,
          }),
        },
      ],
    });
  }
}

function refused(
  reason: Extract<BrowserProfilesResult, { kind: "browser-profiles-refused" }>["reason"],
  message: string,
): BrowserProfilesResult {
  return { kind: "browser-profiles-refused", reason, message };
}
