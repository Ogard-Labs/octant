import type { SettingsSectionEntry } from "./registry";

/** Labels and availability needed before the Settings window loads. */
export const octantSettingsNavigation = {
  general: { id: "general", label: "General", scope: "app" },
  appearance: { id: "appearance", label: "Appearance", scope: "app" },
  sidebar: { id: "sidebar", label: "Sidebar", scope: "app" },
  keybindings: { id: "keybindings", label: "Keybindings", scope: "app" },
  chat: { id: "chat", label: "Chat", scope: "app" },
  work: { id: "work", label: "Work", scope: "host" },
  code: { id: "code", label: "Code", scope: "app" },
  providers: { id: "providers", label: "Providers & Models", scope: "app" },
  harness: { id: "harness", label: "Octant Harness", scope: "app" },
  voice: { id: "voice", label: "Voice & images", scope: "app" },
  skills: { id: "skills", label: "Skills & Extensions", scope: "host" },
  "web-search": { id: "web-search", label: "Web search", scope: "host" },
  "computer-use": { id: "computer-use", label: "Computer use", scope: "host" },
  "device-tools": { id: "device-tools", label: "Device tools", scope: "host" },
  github: { id: "github", label: "GitHub", scope: "host" },
  linear: { id: "linear", label: "Linear", scope: "host" },
  permissions: { id: "permissions", label: "Permissions", scope: "host" },
  memory: { id: "memory", label: "Memory", scope: "host" },
  "secret-stores": { id: "secret-stores", label: "Secret stores", scope: "host" },
  data: { id: "data", label: "Data & storage", scope: "host" },
  todos: { id: "todos", label: "To-dos", scope: "host" },
  sync: { id: "sync", label: "Sync", scope: "host" },
  "remote-access": { id: "remote-access", label: "Remote access", scope: "host" },
  host: { id: "host", label: "Host", scope: "host" },
  usage: { id: "usage", label: "Usage", scope: "host" },
} as const satisfies Record<
  string,
  Pick<SettingsSectionEntry, "id" | "label" | "scope" | "nativeRequired">
>;

export const octantSettingsCommandPages: ReadonlyArray<
  Pick<SettingsSectionEntry, "id" | "label" | "nativeRequired">
> = Object.values(octantSettingsNavigation);
