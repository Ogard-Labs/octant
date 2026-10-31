import { Schema } from "effect";
import { StoredBrowserProfile } from "./browserProfiles";

const strict = { parseOptions: { onExcessProperty: "error" as const } };

/**
 * An extension's identity on this host: 32 lowercase hex characters derived from
 * its name, so installing a folder with the same name updates the extension that
 * is there instead of adding a second one.
 */
export const BrowserExtensionId = Schema.String.pipe(
  Schema.pattern(/^[0-9a-f]{32}$/),
  Schema.brand("BrowserExtensionId"),
);
export type BrowserExtensionId = typeof BrowserExtensionId.Type;

export const BrowserExtensionContentHash = Schema.String.pipe(Schema.pattern(/^[0-9a-f]{64}$/));

const AccessEntry = Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(256));

/**
 * What an extension asks for, as its manifest declares it: API permissions and
 * the site patterns it can read and change. The person is shown this in plain
 * words before enabling, and a later version that asks for more is disabled until
 * they confirm again.
 */
export const BrowserExtensionAccess = Schema.Struct({
  permissions: Schema.Array(AccessEntry).pipe(Schema.maxItems(128)),
  hostPatterns: Schema.Array(AccessEntry).pipe(Schema.maxItems(256)),
}).annotations(strict);
export type BrowserExtensionAccess = typeof BrowserExtensionAccess.Type;

/** One installed extension as Settings and the Browser toolbar list it. */
export const BrowserExtensionSummary = Schema.Struct({
  id: BrowserExtensionId,
  name: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(128)),
  version: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(32)),
  contentHash: BrowserExtensionContentHash,
  access: BrowserExtensionAccess,
  /** The profiles it runs in. Never Private. */
  enabledIn: Schema.Array(StoredBrowserProfile).pipe(Schema.maxItems(4_096)),
  /**
   * Profiles it was running in when an update asked for more than the installed
   * version did. It is off there until the person confirms what is new.
   */
  needsConfirmation: Schema.Array(StoredBrowserProfile).pipe(Schema.maxItems(4_096)),
  /** What the pending update added; present only while `needsConfirmation` is not empty. */
  addedAccess: Schema.optional(BrowserExtensionAccess),
  /** Whether the manifest names a toolbar popup page. */
  hasPopup: Schema.Boolean,
  /** Whether the manifest names an options page. */
  hasOptionsPage: Schema.Boolean,
}).annotations(strict);
export type BrowserExtensionSummary = typeof BrowserExtensionSummary.Type;

/**
 * A person's command about browser extensions. Only a local window sends one;
 * an agent, a plugin, a skill, and a structured reference cannot. Installing
 * names a folder only by the receipt the native folder picker issued.
 */
export const BrowserExtensionsCommand = Schema.Union(
  Schema.Struct({ kind: Schema.Literal("list") }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("install"),
    receiptId: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(128)),
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("enable"),
    extensionId: BrowserExtensionId,
    profile: StoredBrowserProfile,
    /** The version the person was shown; the host refuses if it has changed since. */
    contentHash: BrowserExtensionContentHash,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("disable"),
    extensionId: BrowserExtensionId,
    profile: StoredBrowserProfile,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("remove"),
    extensionId: BrowserExtensionId,
  }).annotations(strict),
);
export type BrowserExtensionsCommand = typeof BrowserExtensionsCommand.Type;

/**
 * Why an extension command did nothing: `extension-not-local` is a paired
 * device or any caller that is not the person at a local window,
 * `extension-unsupported` is a manifest that is not Manifest V3 (or asks for
 * native messaging) or a host with no desktop app, `invalid` is a folder or
 * request the host cannot read, `not-found` is an extension or Project that is
 * not there, and `stale` is a version that changed after the person saw it.
 */
export const BrowserExtensionRefusalReason = Schema.Literal(
  "extension-not-local",
  "extension-unsupported",
  "invalid",
  "not-found",
  "stale",
);
export type BrowserExtensionRefusalReason = typeof BrowserExtensionRefusalReason.Type;

export const BrowserExtensionsResult = Schema.Union(
  Schema.Struct({
    kind: Schema.Literal("browser-extensions"),
    extensions: Schema.Array(BrowserExtensionSummary).pipe(Schema.maxItems(256)),
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("browser-extension-installed"),
    extension: BrowserExtensionSummary,
    /** True when the folder replaced an extension that was already installed. */
    updated: Schema.Boolean,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("browser-extension-changed"),
    extension: BrowserExtensionSummary,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("browser-extension-removed"),
    extensionId: BrowserExtensionId,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("browser-extension-refused"),
    reason: BrowserExtensionRefusalReason,
    message: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(512)),
  }).annotations(strict),
);
export type BrowserExtensionsResult = typeof BrowserExtensionsResult.Type;

export const BROWSER_EXTENSION_EVENT_NAMES = {
  installed: "browser.extension-installed@1",
  updated: "browser.extension-updated@1",
  removed: "browser.extension-removed@1",
  enabled: "browser.extension-enabled@1",
  disabled: "browser.extension-disabled@1",
} as const;

const InstalledFields = {
  extensionId: BrowserExtensionId,
  name: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(128)),
  version: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(32)),
  contentHash: BrowserExtensionContentHash,
  permissions: BrowserExtensionAccess.fields.permissions,
  hostPatterns: BrowserExtensionAccess.fields.hostPatterns,
  hasPopup: Schema.Boolean,
  hasOptionsPage: Schema.Boolean,
} as const;

/** Journaled when a folder is installed: what it is and what it asks for. */
export const BrowserExtensionInstalled = Schema.Struct({
  kind: Schema.Literal("browser-extension-installed"),
  ...InstalledFields,
}).annotations(strict);
export type BrowserExtensionInstalled = typeof BrowserExtensionInstalled.Type;

/** Journaled when installing a folder replaces an installed extension. */
export const BrowserExtensionUpdated = Schema.Struct({
  kind: Schema.Literal("browser-extension-updated"),
  ...InstalledFields,
}).annotations(strict);
export type BrowserExtensionUpdated = typeof BrowserExtensionUpdated.Type;

export const BrowserExtensionRemoved = Schema.Struct({
  kind: Schema.Literal("browser-extension-removed"),
  extensionId: BrowserExtensionId,
}).annotations(strict);
export type BrowserExtensionRemoved = typeof BrowserExtensionRemoved.Type;

/** Journaled when the person enables an extension in one profile, naming the version they saw. */
export const BrowserExtensionEnabled = Schema.Struct({
  kind: Schema.Literal("browser-extension-enabled"),
  extensionId: BrowserExtensionId,
  profile: StoredBrowserProfile,
  contentHash: BrowserExtensionContentHash,
}).annotations(strict);
export type BrowserExtensionEnabled = typeof BrowserExtensionEnabled.Type;

export const BrowserExtensionDisabled = Schema.Struct({
  kind: Schema.Literal("browser-extension-disabled"),
  extensionId: BrowserExtensionId,
  profile: StoredBrowserProfile,
}).annotations(strict);
export type BrowserExtensionDisabled = typeof BrowserExtensionDisabled.Type;

export const decodeBrowserExtensionId = Schema.decodeUnknownSync(BrowserExtensionId);
export const decodeBrowserExtensionsCommand = Schema.decodeUnknownSync(BrowserExtensionsCommand);
export const decodeBrowserExtensionsResult = Schema.decodeUnknownSync(BrowserExtensionsResult);
export const decodeBrowserExtensionSummary = Schema.decodeUnknownSync(BrowserExtensionSummary);
export const decodeBrowserExtensionInstalled = Schema.decodeUnknownSync(BrowserExtensionInstalled);
export const decodeBrowserExtensionUpdated = Schema.decodeUnknownSync(BrowserExtensionUpdated);
export const decodeBrowserExtensionRemoved = Schema.decodeUnknownSync(BrowserExtensionRemoved);
export const decodeBrowserExtensionEnabled = Schema.decodeUnknownSync(BrowserExtensionEnabled);
export const decodeBrowserExtensionDisabled = Schema.decodeUnknownSync(BrowserExtensionDisabled);
