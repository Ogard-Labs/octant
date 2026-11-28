import type { SettingsSectionEntry } from "./registry";

/** Labels and availability needed before the Settings window loads. */
export const octantSettingsNavigation = {
  general: { id: "general", label: "General", scope: "app" },
  appearance: { id: "appearance", label: "Appearance", scope: "app" },
  background: { id: "background", label: "Background", scope: "app" },
  text: { id: "text", label: "Text", scope: "app" },
  sidebar: { id: "sidebar", label: "Sidebar", scope: "app" },
  keybindings: { id: "keybindings", label: "Keybindings", scope: "app" },
  "chat-work": { id: "chat-work", label: "Chat & Work", scope: "app" },
  code: { id: "code", label: "Code", scope: "app" },
  providers: { id: "providers", label: "Providers & Models", scope: "app" },
  harness: { id: "harness", label: "Octant Harness", scope: "app" },
  voice: { id: "voice", label: "Voice & images", scope: "app" },
  skills: { id: "skills", label: "Skills & Extensions", scope: "host" },
  "computer-use": { id: "computer-use", label: "Computer use", scope: "host" },
  integrations: { id: "integrations", label: "Integrations", scope: "host" },
  permissions: { id: "permissions", label: "Permissions", scope: "host" },
  limits: { id: "limits", label: "Limits", scope: "host" },
  memory: { id: "memory", label: "Memory", scope: "host" },
  "secret-stores": { id: "secret-stores", label: "Secret stores", scope: "host" },
  data: { id: "data", label: "Data & storage", scope: "host" },
  sync: { id: "sync", label: "Sync", scope: "host" },
  "remote-access": { id: "remote-access", label: "Remote access", scope: "host" },
  "public-entrance": { id: "public-entrance", label: "Public entrance", scope: "host" },
  host: { id: "host", label: "This computer", scope: "host" },
  usage: { id: "usage", label: "Usage", scope: "host" },
} as const satisfies Record<
  string,
  Pick<SettingsSectionEntry, "id" | "label" | "scope" | "nativeRequired">
>;

type SettingsPageId = keyof typeof octantSettingsNavigation;

/**
 * The pages each page took in. A person still types "Settings: GitHub" or
 * "to-dos" into the command palette, so the page that holds those settings now
 * answers to the old name. A name that was a plugin's page says which section
 * the plugin contributes, and goes when the plugin is off.
 */
const PAGES_TAKEN_IN: Readonly<
  Partial<
    Record<
      SettingsPageId,
      ReadonlyArray<{ readonly label: string; readonly contributedSection?: string }>
    >
  >
> = {
  "chat-work": [{ label: "Chat" }, { label: "Work" }],
  "computer-use": [{ label: "Device tools" }],
  integrations: [
    { label: "Web search" },
    { label: "GitHub", contributedSection: "github" },
    { label: "Linear", contributedSection: "linear" },
  ],
  data: [{ label: "To-dos" }],
};

export interface SettingsCommandPage extends Pick<
  SettingsSectionEntry,
  "id" | "label" | "nativeRequired"
> {
  /** The names of the pages this one took in that are still on offer. */
  readonly alsoFoundAs: ReadonlyArray<string>;
}

/**
 * The Settings pages the command palette offers. A switched-off plugin's page
 * name is not offered, so the palette never names a section that is not there.
 */
export function settingsCommandPages(
  isContributedSectionPresent: (contributedSection: string) => boolean,
): ReadonlyArray<SettingsCommandPage> {
  return Object.values(octantSettingsNavigation).map((page) => ({
    ...page,
    alsoFoundAs: (PAGES_TAKEN_IN[page.id] ?? [])
      .filter(
        (taken) =>
          taken.contributedSection === undefined ||
          isContributedSectionPresent(taken.contributedSection),
      )
      .map((taken) => taken.label),
  }));
}
