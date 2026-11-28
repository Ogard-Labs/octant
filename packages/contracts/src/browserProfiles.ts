import { Schema } from "effect";
import { NonNegativeInt, STRICT_DECODE_OPTIONS } from "./schemaPrimitives";
import { AccountBrowserProfile, BrowserProfileRefusalReason } from "./browserAutomation";
import { ProjectId } from "./projects";

/**
 * A profile that lives on disk: a Work or Code Project's, or the host's
 * Personal one. Private has no store to list or clear.
 */
export const StoredBrowserProfile = Schema.Union([
  AccountBrowserProfile,
  Schema.Struct({ kind: Schema.Literal("project"), projectId: ProjectId }),
  Schema.Struct({ kind: Schema.Literal("personal") }),
]);
export type StoredBrowserProfile = typeof StoredBrowserProfile.Type;

export const BrowserAccountProfileLabel = Schema.Trimmed.check(
  Schema.isNonEmpty(),
  Schema.isMaxLength(80),
);
export const NamedBrowserProfile = Schema.Struct({
  ...AccountBrowserProfile.fields,
  label: BrowserAccountProfileLabel,
});
export type NamedBrowserProfile = typeof NamedBrowserProfile.Type;
export const decodeNamedBrowserProfiles = Schema.decodeUnknownSync(
  Schema.Array(NamedBrowserProfile).check(Schema.isMaxLength(64)),
  STRICT_DECODE_OPTIONS,
);
export const BrowserAccountProfileCreateResult = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("created"),
    profile: AccountBrowserProfile,
    label: BrowserAccountProfileLabel,
  }),
  Schema.Struct({
    status: Schema.Literal("refused"),
    reason: Schema.Literals(["invalid-label", "store-unavailable", "limit-reached"]),
  }),
]);
export type BrowserAccountProfileCreateResult = typeof BrowserAccountProfileCreateResult.Type;
export const decodeBrowserAccountProfileCreateResult = Schema.decodeUnknownSync(
  BrowserAccountProfileCreateResult,
  STRICT_DECODE_OPTIONS,
);

/** What clearing removes: sign-ins alone, or everything the profile stored. */
export const BrowserProfileClearScope = Schema.Literals(["cookies", "all"]);
export type BrowserProfileClearScope = typeof BrowserProfileClearScope.Type;

/**
 * One stored profile as Settings lists it. The size is what the profile
 * occupies on disk; the host never reads a cookie to produce it.
 */
export const BrowserProfileSummary = Schema.Struct({
  profile: StoredBrowserProfile,
  label: Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(256)),
  sizeBytes: NonNegativeInt,
});
export type BrowserProfileSummary = typeof BrowserProfileSummary.Type;

/** A browser installed on this Mac whose cookies a person can import. */
export const CookieImportBrowserId = Schema.Literals([
  "chrome",
  "chromium",
  "brave",
  "edge",
  "vivaldi",
  "arc",
  "firefox",
]);
export type CookieImportBrowserId = typeof CookieImportBrowserId.Type;

/** A website to import, as a host or a pasted address; the host decides what it names. */
const ImportSite = Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(512));

const SourceProfileId = Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(128));

/** One profile of an installed browser, by the name that browser shows. */
export const CookieImportSourceProfile = Schema.Struct({
  id: SourceProfileId,
  label: Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(256)),
});
export type CookieImportSourceProfile = typeof CookieImportSourceProfile.Type;

export const CookieImportSource = Schema.Struct({
  browser: CookieImportBrowserId,
  label: Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(64)),
  profiles: Schema.Array(CookieImportSourceProfile).check(Schema.isMaxLength(64)),
});
export type CookieImportSource = typeof CookieImportSource.Type;

export const MAX_COOKIES_PER_IMPORT_BATCH = 200;

/**
 * One cookie on its way from the host into a profile's store. It exists only
 * between the host and the desktop app on this Mac, never in a journal, a log,
 * an answer to a window, or anything an agent reads.
 */
export const ImportedCookie = Schema.Struct({
  domain: Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(254)),
  hostOnly: Schema.Boolean,
  name: Schema.NonEmptyString.check(Schema.isMaxLength(256)),
  value: Schema.String.check(Schema.isMaxLength(4_096)),
  path: Schema.NonEmptyString.check(Schema.isMaxLength(1_024)),
  secure: Schema.Boolean,
  httpOnly: Schema.Boolean,
  /** Seconds since the Unix epoch; absent for a session cookie. */
  expiresAt: Schema.optional(Schema.Number),
  sameSite: Schema.Literals(["unspecified", "no_restriction", "lax", "strict"]),
});
export type ImportedCookie = typeof ImportedCookie.Type;

/**
 * A person's command about the profiles this host stores. Only a local window
 * may send one; the host decides everything else. Importing names a browser and
 * one of its profiles by the id the listing gave, and carries no cookie.
 */
export const BrowserProfilesCommand = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("create-account"),
    label: BrowserAccountProfileLabel,
  }),
  Schema.Struct({
    kind: Schema.Literal("list"),
    includeSizes: Schema.optional(Schema.Boolean),
  }),
  Schema.Struct({
    kind: Schema.Literal("clear"),
    profile: StoredBrowserProfile,
    scope: BrowserProfileClearScope,
  }),
  Schema.Struct({ kind: Schema.Literal("import-sources") }),
  Schema.Struct({
    kind: Schema.Literal("import-cookies"),
    profile: StoredBrowserProfile,
    browser: CookieImportBrowserId,
    sourceProfile: SourceProfileId,
    /** When present, only this site's cookies and its parent domains' are imported. */
    site: Schema.optional(ImportSite),
  }),
]);
export type BrowserProfilesCommand = typeof BrowserProfilesCommand.Type;

/**
 * Why an import found nothing to import: `source-not-found` is a browser or
 * profile that is not on this Mac, `keychain-refused` is a Keychain prompt the
 * person declined (or could not answer), and `source-unreadable` is a cookie
 * database Octant could not open or decrypt.
 */
export const BrowserProfilesRefusalReason = Schema.Literals([
  "unauthorized",
  "invalid",
  "source-not-found",
  "keychain-refused",
  "source-unreadable",
  ...BrowserProfileRefusalReason.literals,
]);
export type BrowserProfilesRefusalReason = typeof BrowserProfilesRefusalReason.Type;

export const BrowserProfilesResult = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("browser-account-profile-created"),
    profile: AccountBrowserProfile,
    label: BrowserAccountProfileLabel,
  }),
  Schema.Struct({
    kind: Schema.Literal("browser-profiles"),
    profiles: Schema.Array(BrowserProfileSummary).check(Schema.isMaxLength(4_096)),
  }),
  Schema.Struct({
    kind: Schema.Literal("browser-profile-cleared"),
    profile: StoredBrowserProfile,
    scope: BrowserProfileClearScope,
  }),
  Schema.Struct({
    kind: Schema.Literal("browser-cookie-sources"),
    sources: Schema.Array(CookieImportSource).check(Schema.isMaxLength(16)),
  }),
  Schema.Struct({
    kind: Schema.Literal("browser-cookies-imported"),
    profile: StoredBrowserProfile,
    browser: CookieImportBrowserId,
    sourceProfile: SourceProfileId,
    imported: NonNegativeInt,
    skipped: NonNegativeInt,
    /** True when the import was limited to one site; the site itself is never returned. */
    siteOnly: Schema.optional(Schema.Boolean),
  }),
  Schema.Struct({
    kind: Schema.Literal("browser-profiles-refused"),
    reason: BrowserProfilesRefusalReason,
    message: Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(512)),
  }),
]);
export type BrowserProfilesResult = typeof BrowserProfilesResult.Type;

/**
 * Journaled when the person clears a profile. It names the profile and what was
 * removed and never holds a cookie, a site, or a count of either.
 */
export const BROWSER_PROFILE_EVENT_NAMES = {
  cleared: "browser.profile-cleared@1",
  cookiesImported: "browser.cookies-imported@1",
} as const;

export const BrowserProfileCleared = Schema.Struct({
  kind: Schema.Literal("browser-profile-cleared"),
  profile: StoredBrowserProfile,
  scope: BrowserProfileClearScope,
});
export type BrowserProfileCleared = typeof BrowserProfileCleared.Type;

/**
 * Journaled when the person imports another browser's cookies into a profile.
 * It names the source browser and profile and how many cookies arrived, and
 * holds no cookie, name, site, or value.
 */
export const BrowserCookiesImported = Schema.Struct({
  kind: Schema.Literal("browser-cookies-imported"),
  profile: StoredBrowserProfile,
  browser: CookieImportBrowserId,
  sourceProfile: SourceProfileId,
  imported: NonNegativeInt,
  skipped: NonNegativeInt,
  /** Whether the import was limited to one site. The site is not recorded. */
  siteOnly: Schema.optional(Schema.Boolean),
});
export type BrowserCookiesImported = typeof BrowserCookiesImported.Type;

export const decodeStoredBrowserProfile = Schema.decodeUnknownSync(
  StoredBrowserProfile,
  STRICT_DECODE_OPTIONS,
);
export const decodeBrowserProfilesCommand = Schema.decodeUnknownSync(
  BrowserProfilesCommand,
  STRICT_DECODE_OPTIONS,
);
export const decodeBrowserProfilesResult = Schema.decodeUnknownSync(
  BrowserProfilesResult,
  STRICT_DECODE_OPTIONS,
);
export const decodeBrowserProfileCleared = Schema.decodeUnknownSync(
  BrowserProfileCleared,
  STRICT_DECODE_OPTIONS,
);
export const decodeBrowserCookiesImported = Schema.decodeUnknownSync(
  BrowserCookiesImported,
  STRICT_DECODE_OPTIONS,
);
export const decodeImportedCookie = Schema.decodeUnknownSync(ImportedCookie, STRICT_DECODE_OPTIONS);
