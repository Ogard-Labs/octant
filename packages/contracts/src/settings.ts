import { Schema } from "effect";

const strict = { parseOptions: { onExcessProperty: "error" as const } };

/**
 * Durable Settings information-architecture section identifiers.
 *
 * The registry in the renderer decides which of these sections are currently
 * available (only sections with working content are shown). The contract
 * enumerates the full IA so any app surface can request a deep link by name.
 */
export const SETTINGS_SECTION_IDS = [
  "general",
  "profile",
  "appearance",
  "keybindings",
  "chat",
  "work",
  "code",
  "providers",
  "harness",
  "navigator-assistant",
  "voice",
  "image-generation",
  "computer-use",
  "skills",
  "github",
  "linear",
  "host",
  "data",
  "remote-access",
  "usage",
] as const;

export const SettingsSectionId = Schema.Literal(...SETTINGS_SECTION_IDS);
export type SettingsSectionId = typeof SettingsSectionId.Type;

/**
 * Identifier for an individual setting within a section.
 *
 * Kept as a trimmed non-empty string (not a literal) so the renderer-owned
 * registry can grow without churning the wire contract. Deep-link `setting`
 * values are validated through the contract schema before reaching the
 * registry.
 */
export const SettingsSettingId = Schema.Trimmed.pipe(Schema.minLength(1));
export type SettingsSettingId = typeof SettingsSettingId.Type;

/**
 * Deep link into the Settings surface.
 *
 * `section` is required; `setting` optionally focuses an exact control within
 * that section. Other app surfaces (empty states, provider/model errors, etc.)
 * use this to open the exact Settings destination.
 */
/**
 * Sections earlier builds linked to, read as the section that holds their
 * settings now. A host or client from before the regrouping still sends
 * them, and a link it sends must land on the control rather than fail to
 * decode. Encoding always writes the current identifier.
 */
const RetiredSettingsSectionId = Schema.transformLiterals(
  ["advanced", "host"],
  ["agents", "harness"],
  ["profiles", "providers"],
);

export const SettingsDeepLink = Schema.Struct({
  section: Schema.Union(SettingsSectionId, RetiredSettingsSectionId),
  setting: Schema.optional(SettingsSettingId),
}).annotations(strict);
export type SettingsDeepLink = typeof SettingsDeepLink.Type;
