import { SandboxRestrictionsScope } from "./sandboxPolicy";
import { Schema } from "effect";

/**
 * Durable Settings information-architecture section identifiers.
 *
 * The registry in the renderer decides which of these sections are currently
 * available (only sections with working content are shown). The contract
 * enumerates the full IA so any app surface can request a deep link by name.
 *
 * A page that was folded into another keeps its identifier here (`profile`,
 * `chat`, `github`, `todos`, `web-search` and the like), so a link an earlier build wrote
 * still decodes; the renderer opens the page that holds its settings now.
 */
export const SETTINGS_SECTION_IDS = [
  "general",
  "profile",
  "notifications",
  "appearance",
  "background",
  "text",
  "sidebar",
  "keybindings",
  "chat",
  "work",
  "chat-work",
  "code",
  "providers",
  "harness",
  "voice",
  "skills",
  "web-search",
  "computer-use",
  "device-tools",
  "github",
  "linear",
  "integrations",
  "permissions",
  "access",
  "limits",
  "memory",
  "secret-stores",
  "data",
  "todos",
  "sync",
  "remote-access",
  "public-entrance",
  "host",
  "usage",
] as const;

export const SettingsSectionId = Schema.Literals(SETTINGS_SECTION_IDS);
export type SettingsSectionId = typeof SettingsSectionId.Type;

/**
 * Identifier for an individual setting within a section.
 *
 * Kept as a trimmed non-empty string (not a literal) so the renderer-owned
 * registry can grow without churning the wire contract. Deep-link `setting`
 * values are validated through the contract schema before reaching the
 * registry.
 */
export const SettingsSettingId = Schema.Trimmed.check(Schema.isMinLength(1));
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
const RetiredSettingsSectionId = Schema.Literals([
  "advanced",
  "agents",
  "profiles",
  "provider-catalog",
  "navigator-assistant",
  "image-generation",
  "ssh-targets",
]).transform(["host", "harness", "providers", "providers", "harness", "voice", "host"]);

export const SettingsDeepLink = Schema.Struct({
  sandboxScope: Schema.optional(SandboxRestrictionsScope),
  section: Schema.Union([SettingsSectionId, RetiredSettingsSectionId]),
  setting: Schema.optional(SettingsSettingId),
});
export type SettingsDeepLink = typeof SettingsDeepLink.Type;
