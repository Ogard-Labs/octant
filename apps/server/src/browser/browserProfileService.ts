import {
  BROWSER_PROFILE_EVENT_NAMES,
  AggregateId,
  AggregateVersion,
  CorrelationId,
  EventActor,
  EventId,
  EventName,
  UtcTimestamp,
  decodeBrowserCookiesImported,
  decodeBrowserProfileCleared,
  decodeBrowserProfilesResult,
  MAX_COOKIES_PER_IMPORT_BATCH,
  type CookieImportBrowserId,
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
import { normalizeImportSite } from "./cookieImport/importedCookie";
import type { BrowserCookieReader, CookieReadRefusal } from "./cookieImport/browserCookieReader";

const decodeAggregateId = Schema.decodeUnknownSync(AggregateId);
const decodeAggregateVersion = Schema.decodeUnknownSync(AggregateVersion);
const decodeCorrelationId = Schema.decodeUnknownSync(CorrelationId);
const decodeEventActor = Schema.decodeUnknownSync(EventActor);
const decodeEventId = Schema.decodeUnknownSync(EventId);
const decodeEventName = Schema.decodeUnknownSync(EventName);
const decodeTimestamp = Schema.decodeUnknownSync(UtcTimestamp);

export const BROWSER_PROFILE_AGGREGATE = "browser-profile";

/** What a person is told when an import found nothing to import; no reason carries a site or a cookie. */
const IMPORT_REFUSALS: Readonly<Record<CookieReadRefusal, string>> = {
  "source-not-found": "That browser or profile is not on this Mac.",
  "keychain-refused":
    "macOS did not allow Octant to read the browser's cookie key, so nothing was imported.",
  "source-unreadable": "Octant could not read that browser's cookies, so nothing was imported.",
};

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
  /** Reads another browser's cookies on the person's pick; absent where the host has none to offer. */
  readonly cookieReader?: BrowserCookieReader;
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
    if (command.kind === "import-sources") {
      return decodeBrowserProfilesResult({
        kind: "browser-cookie-sources",
        sources: this.#options.cookieReader?.listSources() ?? [],
      });
    }
    if (command.kind === "import-cookies") {
      return this.#importCookies(
        store,
        command.profile,
        command.browser,
        command.sourceProfile,
        command.site,
      );
    }
    return this.#clear(store, command.profile, command.scope);
  }

  /**
   * Copies one browser profile's cookies into one Octant profile, only because
   * the person picked both. The cookies move from the source database to the
   * desktop app's store and stop there: nothing here returns, journals, or logs
   * a cookie, a site, or a value, and a failure at any step reports a fixed
   * sentence.
   */
  async #importCookies(
    store: NonNullable<BrowserRuntimePort["profiles"]>,
    profile: StoredBrowserProfile,
    browser: CookieImportBrowserId,
    sourceProfile: string,
    siteInput: string | undefined,
  ): Promise<BrowserProfilesResult> {
    const site = siteInput === undefined ? undefined : normalizeImportSite(siteInput);
    if (siteInput !== undefined && site === undefined) {
      return refused("invalid", "Enter a website like example.com.");
    }
    const siteOnly = site !== undefined;
    const reader = this.#options.cookieReader;
    if (reader === undefined) {
      return refused("source-not-found", "This Mac has no other browser to import cookies from.");
    }
    const read = await reader.read(browser, sourceProfile, site);
    if (read.status === "refused") return refused(read.reason, IMPORT_REFUSALS[read.reason]);
    let imported = 0;
    let skipped = read.skipped;
    try {
      for (let start = 0; start < read.cookies.length; start += MAX_COOKIES_PER_IMPORT_BATCH) {
        const batch = await store.importCookies(
          profile,
          read.cookies.slice(start, start + MAX_COOKIES_PER_IMPORT_BATCH),
        );
        imported += batch.imported;
        skipped += batch.skipped;
      }
    } catch {
      // Whatever arrived before the failure is in the profile and is recorded.
      if (imported > 0)
        this.#journalImported(profile, browser, sourceProfile, imported, skipped, siteOnly);
      return refused("profile-unavailable", "The cookies could not be added to this profile.");
    }
    this.#journalImported(profile, browser, sourceProfile, imported, skipped, siteOnly);
    return decodeBrowserProfilesResult({
      kind: "browser-cookies-imported",
      profile,
      browser,
      sourceProfile,
      imported,
      skipped,
      ...(siteOnly ? { siteOnly } : {}),
    });
  }

  #journalImported(
    profile: StoredBrowserProfile,
    browser: CookieImportBrowserId,
    sourceProfile: string,
    imported: number,
    skipped: number,
    siteOnly: boolean,
  ): void {
    this.#append(
      BROWSER_PROFILE_EVENT_NAMES.cookiesImported,
      decodeBrowserCookiesImported({
        kind: "browser-cookies-imported",
        profile,
        browser,
        sourceProfile,
        imported,
        skipped,
        ...(siteOnly ? { siteOnly } : {}),
      }),
    );
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
    this.#append(
      BROWSER_PROFILE_EVENT_NAMES.cleared,
      decodeBrowserProfileCleared({ kind: "browser-profile-cleared", profile, scope }),
    );
  }

  #append(eventName: string, payload: unknown): void {
    this.#options.journal.append({
      aggregate: {
        aggregateType: BROWSER_PROFILE_AGGREGATE,
        aggregateId: decodeAggregateId(this.#options.uuid()),
      },
      expectedVersion: decodeAggregateVersion(0),
      events: [
        {
          eventId: decodeEventId(this.#options.uuid()),
          eventName: decodeEventName(eventName),
          eventVersion: 1,
          correlationId: decodeCorrelationId(this.#options.uuid()),
          actor: decodeEventActor(this.#options.actor),
          occurredAt: decodeTimestamp(this.#options.clock()),
          payload,
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
