import { Schema } from "effect";
import { BrowserProfileRefusalReason } from "./browserAutomation";
import { ProjectId } from "./projects";

const strict = { parseOptions: { onExcessProperty: "error" as const } };

/**
 * A profile that lives on disk: a Work or Code Project's, or the host's
 * Personal one. Private has no store to list or clear.
 */
export const StoredBrowserProfile = Schema.Union(
  Schema.Struct({ kind: Schema.Literal("project"), projectId: ProjectId }).annotations(strict),
  Schema.Struct({ kind: Schema.Literal("personal") }).annotations(strict),
);
export type StoredBrowserProfile = typeof StoredBrowserProfile.Type;

/** What clearing removes: sign-ins alone, or everything the profile stored. */
export const BrowserProfileClearScope = Schema.Literal("cookies", "all");
export type BrowserProfileClearScope = typeof BrowserProfileClearScope.Type;

/**
 * One stored profile as Settings lists it. The size is what the profile
 * occupies on disk; the host never reads a cookie to produce it.
 */
export const BrowserProfileSummary = Schema.Struct({
  profile: StoredBrowserProfile,
  label: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(256)),
  sizeBytes: Schema.Int.pipe(Schema.nonNegative()),
}).annotations(strict);
export type BrowserProfileSummary = typeof BrowserProfileSummary.Type;

/**
 * A person's command about the profiles this host stores. Only a local window
 * may send one; the host decides everything else.
 */
export const BrowserProfilesCommand = Schema.Union(
  Schema.Struct({ kind: Schema.Literal("list") }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("clear"),
    profile: StoredBrowserProfile,
    scope: BrowserProfileClearScope,
  }).annotations(strict),
);
export type BrowserProfilesCommand = typeof BrowserProfilesCommand.Type;

export const BrowserProfilesRefusalReason = Schema.Literal(
  "unauthorized",
  "invalid",
  ...BrowserProfileRefusalReason.literals,
);
export type BrowserProfilesRefusalReason = typeof BrowserProfilesRefusalReason.Type;

export const BrowserProfilesResult = Schema.Union(
  Schema.Struct({
    kind: Schema.Literal("browser-profiles"),
    profiles: Schema.Array(BrowserProfileSummary).pipe(Schema.maxItems(4_096)),
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("browser-profile-cleared"),
    profile: StoredBrowserProfile,
    scope: BrowserProfileClearScope,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("browser-profiles-refused"),
    reason: BrowserProfilesRefusalReason,
    message: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(512)),
  }).annotations(strict),
);
export type BrowserProfilesResult = typeof BrowserProfilesResult.Type;

/**
 * Journaled when the person clears a profile. It names the profile and what was
 * removed and never holds a cookie, a site, or a count of either.
 */
export const BROWSER_PROFILE_EVENT_NAMES = {
  cleared: "browser.profile-cleared@1",
} as const;

export const BrowserProfileCleared = Schema.Struct({
  kind: Schema.Literal("browser-profile-cleared"),
  profile: StoredBrowserProfile,
  scope: BrowserProfileClearScope,
}).annotations(strict);
export type BrowserProfileCleared = typeof BrowserProfileCleared.Type;

export const decodeStoredBrowserProfile = Schema.decodeUnknownSync(StoredBrowserProfile);
export const decodeBrowserProfilesCommand = Schema.decodeUnknownSync(BrowserProfilesCommand);
export const decodeBrowserProfilesResult = Schema.decodeUnknownSync(BrowserProfilesResult);
export const decodeBrowserProfileCleared = Schema.decodeUnknownSync(BrowserProfileCleared);
