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
  "appearance",
  "keybindings",
  "chat",
  "work",
  "code",
  "navigator-assistant",
  "voice",
  "image-generation",
  "providers",
  "profiles",
  "agents",
  "harness",
  "skills",
  "usage",
  "host",
  "github",
  "linear",
  "advanced",
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
export const SettingsDeepLink = Schema.Struct({
  section: SettingsSectionId,
  setting: Schema.optional(SettingsSettingId),
}).annotations(strict);
export type SettingsDeepLink = typeof SettingsDeepLink.Type;
