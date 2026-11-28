import { Schema } from "effect";
import { STRICT_DECODE_OPTIONS } from "./schemaPrimitives";
import { StoredBrowserProfile } from "./browserProfiles";

/**
 * An extension's identity on this host: 32 lowercase hex characters derived from
 * its name, so installing a folder with the same name updates the extension that
 * is there instead of adding a second one.
 */
export const BrowserExtensionId = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^[0-9a-f]{32}$/)),
  Schema.brand("BrowserExtensionId"),
);
export type BrowserExtensionId = typeof BrowserExtensionId.Type;

export const BrowserExtensionContentHash = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/));

const AccessEntry = Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(256));

/**
 * What an extension asks for, as its manifest declares it: API permissions and
 * the site patterns it can read and change. The person is shown this in plain
 * words before enabling, and a later version that asks for more is disabled until
 * they confirm again.
 */
export const BrowserExtensionAccess = Schema.Struct({
  permissions: Schema.Array(AccessEntry).check(Schema.isMaxLength(128)),
  hostPatterns: Schema.Array(AccessEntry).check(Schema.isMaxLength(256)),
});
export type BrowserExtensionAccess = typeof BrowserExtensionAccess.Type;

/** One installed extension as Settings and the Browser toolbar list it. */
export const BrowserExtensionSummary = Schema.Struct({
  id: BrowserExtensionId,
  name: Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(128)),
  version: Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(32)),
  contentHash: BrowserExtensionContentHash,
  access: BrowserExtensionAccess,
  /** The profiles it runs in. Never Private. */
  enabledIn: Schema.Array(StoredBrowserProfile).check(Schema.isMaxLength(4_096)),
  /**
   * Profiles it was running in when an update asked for more than the installed
   * version did. It is off there until the person confirms what is new.
   */
  needsConfirmation: Schema.Array(StoredBrowserProfile).check(Schema.isMaxLength(4_096)),
  /** What the pending update added; present only while `needsConfirmation` is not empty. */
  addedAccess: Schema.optional(BrowserExtensionAccess),
  /** Whether the manifest names a toolbar popup page. */
  hasPopup: Schema.Boolean,
  /** Whether the manifest names an options page. */
  hasOptionsPage: Schema.Boolean,
});
export type BrowserExtensionSummary = typeof BrowserExtensionSummary.Type;

/** The Chromium-family browsers whose installed extensions a person can copy in. */
export const ExtensionImportBrowserId = Schema.Literals([
  "chrome",
  "chromium",
  "brave",
  "edge",
  "vivaldi",
  "arc",
]);
export type ExtensionImportBrowserId = typeof ExtensionImportBrowserId.Type;

/** The id a Chromium-family browser gives an extension: 32 letters a to p. */
const SourceExtensionId = Schema.String.check(Schema.isPattern(/^[a-p]{32}$/));
const SourceProfileId = Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(128));

/**
 * One extension found in another browser's profile. When Octant cannot run it,
 * `unsupportedReason` says why in plain words and the person cannot pick it.
 */
export const ExtensionImportCandidate = Schema.Struct({
  id: SourceExtensionId,
  name: Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(128)),
  version: Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(32)),
  unsupportedReason: Schema.optional(
    Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(256)),
  ),
});
export type ExtensionImportCandidate = typeof ExtensionImportCandidate.Type;

export const ExtensionImportSource = Schema.Struct({
  browser: ExtensionImportBrowserId,
  label: Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(64)),
  profiles: Schema.Array(
    Schema.Struct({
      id: SourceProfileId,
      label: Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(256)),
      extensions: Schema.Array(ExtensionImportCandidate).check(Schema.isMaxLength(256)),
    }),
  ).check(Schema.isMaxLength(64)),
});
export type ExtensionImportSource = typeof ExtensionImportSource.Type;

/**
 * A person's command about browser extensions. Only a local window sends one;
 * an agent, a plugin, a skill, and a structured reference cannot. Installing
 * names a folder only by the receipt the native folder picker issued.
 */
export const BrowserExtensionsCommand = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("list") }),
  Schema.Struct({
    kind: Schema.Literal("install"),
    receiptId: Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(128)),
  }),
  Schema.Struct({ kind: Schema.Literal("import-sources") }),
  Schema.Struct({
    kind: Schema.Literal("import"),
    browser: ExtensionImportBrowserId,
    sourceProfile: SourceProfileId,
    sourceExtensionId: SourceExtensionId,
  }),
  Schema.Struct({
    kind: Schema.Literal("enable"),
    extensionId: BrowserExtensionId,
    profile: StoredBrowserProfile,
    /** The version the person was shown; the host refuses if it has changed since. */
    contentHash: BrowserExtensionContentHash,
  }),
  Schema.Struct({
    kind: Schema.Literal("disable"),
    extensionId: BrowserExtensionId,
    profile: StoredBrowserProfile,
  }),
  Schema.Struct({
    kind: Schema.Literal("remove"),
    extensionId: BrowserExtensionId,
  }),
]);
export type BrowserExtensionsCommand = typeof BrowserExtensionsCommand.Type;

/**
 * Why an extension command did nothing: `extension-not-local` is a paired
 * device or any caller that is not the person at a local window,
 * `extension-unsupported` is a manifest that is not Manifest V3 (or asks for
 * native messaging) or a host with no desktop app, `invalid` is a folder or
 * request the host cannot read, `not-found` is an extension or Project that is
 * not there, and `stale` is a version that changed after the person saw it.
 */
export const BrowserExtensionRefusalReason = Schema.Literals([
  "extension-not-local",
  "extension-unsupported",
  "invalid",
  "not-found",
  "stale",
]);
export type BrowserExtensionRefusalReason = typeof BrowserExtensionRefusalReason.Type;

export const BrowserExtensionsResult = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("browser-extensions"),
    extensions: Schema.Array(BrowserExtensionSummary).check(Schema.isMaxLength(256)),
  }),
  Schema.Struct({
    kind: Schema.Literal("browser-extension-import-sources"),
    sources: Schema.Array(ExtensionImportSource).check(Schema.isMaxLength(16)),
  }),
  Schema.Struct({
    kind: Schema.Literal("browser-extension-installed"),
    extension: BrowserExtensionSummary,
    /** True when the folder replaced an extension that was already installed. */
    updated: Schema.Boolean,
  }),
  Schema.Struct({
    kind: Schema.Literal("browser-extension-changed"),
    extension: BrowserExtensionSummary,
  }),
  Schema.Struct({
    kind: Schema.Literal("browser-extension-removed"),
    extensionId: BrowserExtensionId,
  }),
  Schema.Struct({
    kind: Schema.Literal("browser-extension-refused"),
    reason: BrowserExtensionRefusalReason,
    message: Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(512)),
  }),
]);
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
  name: Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(128)),
  version: Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(32)),
  contentHash: BrowserExtensionContentHash,
  permissions: BrowserExtensionAccess.fields.permissions,
  hostPatterns: BrowserExtensionAccess.fields.hostPatterns,
  hasPopup: Schema.Boolean,
  hasOptionsPage: Schema.Boolean,
  /** The browser the folder was copied from, when it was not picked from a folder. */
  importedFrom: Schema.optional(ExtensionImportBrowserId),
} as const;

/** Journaled when a folder is installed: what it is and what it asks for. */
export const BrowserExtensionInstalled = Schema.Struct({
  kind: Schema.Literal("browser-extension-installed"),
  ...InstalledFields,
});
export type BrowserExtensionInstalled = typeof BrowserExtensionInstalled.Type;

/** Journaled when installing a folder replaces an installed extension. */
export const BrowserExtensionUpdated = Schema.Struct({
  kind: Schema.Literal("browser-extension-updated"),
  ...InstalledFields,
});
export type BrowserExtensionUpdated = typeof BrowserExtensionUpdated.Type;

export const BrowserExtensionRemoved = Schema.Struct({
  kind: Schema.Literal("browser-extension-removed"),
  extensionId: BrowserExtensionId,
});
export type BrowserExtensionRemoved = typeof BrowserExtensionRemoved.Type;

/** Journaled when the person enables an extension in one profile, naming the version they saw. */
export const BrowserExtensionEnabled = Schema.Struct({
  kind: Schema.Literal("browser-extension-enabled"),
  extensionId: BrowserExtensionId,
  profile: StoredBrowserProfile,
  contentHash: BrowserExtensionContentHash,
});
export type BrowserExtensionEnabled = typeof BrowserExtensionEnabled.Type;

export const BrowserExtensionDisabled = Schema.Struct({
  kind: Schema.Literal("browser-extension-disabled"),
  extensionId: BrowserExtensionId,
  profile: StoredBrowserProfile,
});
export type BrowserExtensionDisabled = typeof BrowserExtensionDisabled.Type;

export const decodeBrowserExtensionId = Schema.decodeUnknownSync(
  BrowserExtensionId,
  STRICT_DECODE_OPTIONS,
);
export const decodeBrowserExtensionsCommand = Schema.decodeUnknownSync(
  BrowserExtensionsCommand,
  STRICT_DECODE_OPTIONS,
);
export const decodeBrowserExtensionsResult = Schema.decodeUnknownSync(
  BrowserExtensionsResult,
  STRICT_DECODE_OPTIONS,
);
export const decodeBrowserExtensionSummary = Schema.decodeUnknownSync(
  BrowserExtensionSummary,
  STRICT_DECODE_OPTIONS,
);
export const decodeBrowserExtensionInstalled = Schema.decodeUnknownSync(
  BrowserExtensionInstalled,
  STRICT_DECODE_OPTIONS,
);
export const decodeBrowserExtensionUpdated = Schema.decodeUnknownSync(
  BrowserExtensionUpdated,
  STRICT_DECODE_OPTIONS,
);
export const decodeBrowserExtensionRemoved = Schema.decodeUnknownSync(
  BrowserExtensionRemoved,
  STRICT_DECODE_OPTIONS,
);
export const decodeBrowserExtensionEnabled = Schema.decodeUnknownSync(
  BrowserExtensionEnabled,
  STRICT_DECODE_OPTIONS,
);
export const decodeBrowserExtensionDisabled = Schema.decodeUnknownSync(
  BrowserExtensionDisabled,
  STRICT_DECODE_OPTIONS,
);
