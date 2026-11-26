import type { SettingsSectionEntry } from "./registry";

/** Labels and availability needed before the Settings window loads. */
export const octantSettingsNavigation = {
  general: { id: "general", label: "General", scope: "app" },
  appearance: { id: "appearance", label: "Appearance", scope: "app" },
  sidebar: { id: "sidebar", label: "Sidebar", scope: "app" },
  keybindings: { id: "keybindings", label: "Keybindings", scope: "app" },
  "chat-work": { id: "chat-work", label: "Chat & Work", scope: "app" },
  code: { id: "code", label: "Code", scope: "app" },
  providers: { id: "providers", label: "Providers & Models", scope: "app" },
  harness: { id: "harness", label: "Octant Harness", scope: "app" },
  voice: { id: "voice", label: "Voice & images", scope: "app" },
  skills: { id: "skills", label: "Skills & Extensions", scope: "host" },
  "web-search": { id: "web-search", label: "Web search", scope: "host" },
  "computer-use": { id: "computer-use", label: "Computer use", scope: "host" },
  integrations: { id: "integrations", label: "Integrations", scope: "host" },
  permissions: { id: "permissions", label: "Permissions", scope: "host" },
  limits: { id: "limits", label: "Limits", scope: "host" },
  memory: { id: "memory", label: "Memory", scope: "host" },
  "secret-stores": { id: "secret-stores", label: "Secret stores", scope: "host" },
  data: { id: "data", label: "Data & storage", scope: "host" },
  sync: { id: "sync", label: "Sync", scope: "host" },
  "remote-access": { id: "remote-access", label: "Remote access", scope: "host" },
  host: { id: "host", label: "Host", scope: "host" },
  usage: { id: "usage", label: "Usage", scope: "host" },
} as const satisfies Record<
  string,
  Pick<SettingsSectionEntry, "id" | "label" | "scope" | "nativeRequired">
>;

/**
 * The names of the pages each page took in. GitHub, Linear, Device tools and
 * To-dos were pages of one to three settings, and a person still types those
 * names into the command palette, where only a page's own name is matched.
 */
const PAGES_TAKEN_IN: Readonly<
  Partial<Record<keyof typeof octantSettingsNavigation, ReadonlyArray<string>>>
> = {
  "computer-use": ["Device tools"],
  integrations: ["GitHub", "Linear"],
  data: ["To-dos"],
};

export const octantSettingsCommandPages: ReadonlyArray<
  Pick<SettingsSectionEntry, "id" | "label" | "nativeRequired"> & {
    readonly alsoFoundAs: ReadonlyArray<string>;
  }
> = Object.values(octantSettingsNavigation).map((page) => ({
  ...page,
  alsoFoundAs: PAGES_TAKEN_IN[page.id] ?? [],
}));
