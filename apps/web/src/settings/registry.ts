import type { SettingsDeepLink, SettingsSectionId, SettingsSettingId } from "@octant/contracts";

/**
 * Authority scope for a setting or section. Surfaced on every relevant control
 * so the user knows whether it applies to this account/app, the selected host,
 * a mode, a Project, or a thread.
 */
export type SettingsScope = "app" | "host" | "mode" | "project" | "thread";

/**
 * Native capabilities that gate section/setting availability. Controls that
 * require a native capability are absent (not disabled) when unsupported, e.g.
 * in the authenticated browser app.
 */
export interface SettingsNativeCapabilities {
  readonly nativeBoundsAvailable: boolean;
  readonly sidebarVibrancySupported: boolean;
}

export type SettingsNativeCapabilityKey = keyof SettingsNativeCapabilities;

export interface SettingsSettingEntry {
  readonly id: SettingsSettingId;
  readonly label: string;
  readonly scope: SettingsScope;
  readonly keywords: string;
  readonly nativeRequired?: SettingsNativeCapabilityKey;
}

export interface SettingsSectionEntry {
  readonly id: SettingsSectionId;
  readonly label: string;
  readonly scope: SettingsScope;
  readonly keywords: string;
  readonly nativeRequired?: SettingsNativeCapabilityKey;
  readonly settings: ReadonlyArray<SettingsSettingEntry>;
}

export interface SettingsRegistry {
  readonly sections: ReadonlyArray<SettingsSectionEntry>;
}

export interface SettingsResolvedDeepLink {
  readonly section: SettingsSectionEntry;
  readonly settingId: SettingsSettingId | undefined;
}

export type SettingsSearchResult =
  | {
      readonly kind: "section";
      readonly sectionId: SettingsSectionId;
      readonly label: string;
      readonly scope: SettingsScope;
    }
  | {
      readonly kind: "setting";
      readonly sectionId: SettingsSectionId;
      readonly settingId: SettingsSettingId;
      readonly label: string;
      readonly scope: SettingsScope;
    };

/**
 * Trust an internal string as a {@link SettingsSettingId}. The registry is
 * renderer-owned and trusted; external deep-link ids are validated through the
 * contract schema before reaching the registry.
 */
export function settingId(raw: string): SettingsSettingId {
  return raw;
}

export function createSettingsRegistry(input: {
  readonly sections: ReadonlyArray<{
    readonly id: SettingsSectionId;
    readonly label: string;
    readonly scope: SettingsScope;
    readonly keywords: string;
    readonly nativeRequired?: SettingsNativeCapabilityKey;
    readonly settings: ReadonlyArray<
      Omit<SettingsSettingEntry, "id"> & { readonly id: SettingsSettingId }
    >;
  }>;
}): SettingsRegistry {
  const seenSections = new Set<SettingsSectionId>();
  for (const section of input.sections) {
    if (seenSections.has(section.id)) {
      throw new Error(`Duplicate Settings section id: ${section.id}`);
    }
    seenSections.add(section.id);
    const seenSettings = new Set<SettingsSettingId>();
    for (const setting of section.settings) {
      if (seenSettings.has(setting.id)) {
        throw new Error(`Duplicate Settings setting id in ${section.id}: ${setting.id}`);
      }
      seenSettings.add(setting.id);
    }
  }
  return { sections: input.sections as ReadonlyArray<SettingsSectionEntry> };
}

export function findSection(
  registry: SettingsRegistry,
  sectionId: SettingsSectionId,
): SettingsSectionEntry | undefined {
  return registry.sections.find((section) => section.id === sectionId);
}

export function findSetting(
  section: SettingsSectionEntry,
  settingId: SettingsSettingId,
): SettingsSettingEntry | undefined {
  return section.settings.find((setting) => setting.id === settingId);
}

export function normalizeSettingsQuery(value: string): string {
  return value
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

export function isSectionAvailable(
  section: SettingsSectionEntry,
  capabilities: SettingsNativeCapabilities,
): boolean {
  if (section.nativeRequired === undefined) return true;
  return capabilities[section.nativeRequired] === true;
}

export function isSettingAvailable(
  setting: SettingsSettingEntry,
  capabilities: SettingsNativeCapabilities,
): boolean {
  if (setting.nativeRequired === undefined) return true;
  return capabilities[setting.nativeRequired] === true;
}

export function listAvailableSections(
  registry: SettingsRegistry,
  capabilities: SettingsNativeCapabilities,
): ReadonlyArray<SettingsSectionEntry> {
  return registry.sections.filter((section) => isSectionAvailable(section, capabilities));
}

/**
 * Words people search Settings with that the rows themselves do not use. Each
 * query word also matches its alternatives, so "dark mode" finds the colour
 * scheme and "password" finds where credentials are kept. Before this a query
 * had to appear as one exact phrase in a row's label or keywords, and
 * "dark mode", "connector", "password", "delete data", and "telemetry" all
 * found nothing.
 */
const SEARCH_ALTERNATIVES: Readonly<Record<string, ReadonlyArray<string>>> = {
  dark: ["scheme", "preset", "theme"],
  light: ["scheme", "preset", "theme"],
  mode: ["scheme", "preset", "theme", "modes"],
  theme: ["appearance", "scheme", "preset"],
  colour: ["color", "accent", "scheme"],
  color: ["colour", "accent", "scheme"],
  font: ["typography", "typeface", "text"],
  password: ["credential", "credentials", "keychain", "secret"],
  login: ["sign", "account", "connection", "credential"],
  logout: ["log", "sign", "disconnect", "remove"],
  signout: ["log", "sign", "disconnect"],
  out: ["logout", "disconnect", "remove", "leave"],
  key: ["credential", "credentials", "endpoint", "token", "keychain"],
  token: ["credential", "key", "keychain"],
  delete: ["purge", "remove", "clear", "erase", "retention", "forget"],
  remove: ["purge", "delete", "clear", "forget", "revoke"],
  erase: ["purge", "delete", "clear"],
  telemetry: ["leaves", "privacy", "data", "network"],
  analytics: ["telemetry", "leaves", "privacy"],
  tracking: ["telemetry", "leaves", "privacy"],
  connector: ["mcp", "server", "extension", "extensions", "plugin"],
  connectors: ["mcp", "server", "extension", "extensions", "plugin"],
  mcp: ["connector", "server", "extension"],
  plugin: ["extension", "extensions", "skills"],
  notification: ["notifications", "notify", "alert"],
  notify: ["notification", "notifications", "alert"],
  alert: ["notification", "notifications", "notify"],
  shortcut: ["keybinding", "keybindings", "keyboard", "hotkey"],
  shortcuts: ["keybinding", "keybindings", "keyboard", "hotkey"],
  hotkey: ["shortcut", "keybinding", "keyboard"],
  anthropic: ["claude"],
  claude: ["anthropic"],
  openai: ["codex", "gpt"],
  codex: ["openai"],
  sound: ["voice", "speech", "audio"],
  audio: ["voice", "speech"],
  microphone: ["voice", "speech", "dictation"],
  mic: ["voice", "speech", "dictation"],
  nightly: ["preview", "ring", "update"],
  beta: ["preview", "ring", "candidate"],
  upgrade: ["update", "updates"],
  worktree: ["checkout", "branch", "worktrees"],
  backup: ["snapshot", "export", "restore"],
  restore: ["snapshot", "backup", "recovery"],
  phone: ["pair", "pairing", "remote", "device"],
  mobile: ["pair", "pairing", "remote", "device"],
  cost: ["usage", "spend", "price"],
  spend: ["usage", "cost", "ceiling"],
  quota: ["usage", "limits", "limit"],
  editor: ["external", "open"],
  vscode: ["editor", "external", "open"],
  wallpaper: ["background", "photo"],
  transparent: ["translucent", "glass", "transparency"],
  blur: ["glass", "translucent", "vibrancy"],
};

/** Words a person types around what they mean ("delete my data"). */
const FILLER_WORDS = new Set([
  "a",
  "an",
  "the",
  "my",
  "i",
  "to",
  "of",
  "in",
  "on",
  "for",
  "how",
  "where",
  "is",
  "do",
  "can",
]);

/** The words a person typed that search matches, for highlighting a result. */
export function settingsQueryWords(query: string): ReadonlyArray<string> {
  return queryTerms(normalizeSettingsQuery(query)).flatMap((accepted) => accepted.slice(0, 1));
}

/**
 * The query's words, each with the words it also accepts. Filler words are
 * left out unless the query has nothing else.
 */
function queryTerms(normalizedQuery: string): ReadonlyArray<ReadonlyArray<string>> {
  const words = normalizedQuery.split(" ").filter((word) => word !== "");
  const meaningful = words.filter((word) => !FILLER_WORDS.has(word));
  return (meaningful.length === 0 ? words : meaningful).map((word) => [
    word,
    ...(SEARCH_ALTERNATIVES[word] ?? []),
  ]);
}

/**
 * Whether every query word matches the start of some word in the text, so the
 * words may come in any order and a word may be typed partly ("notif").
 */
function matchesTerms(text: string, terms: ReadonlyArray<ReadonlyArray<string>>): boolean {
  if (terms.length === 0) return true;
  const words = text.split(" ");
  return terms.every((accepted) =>
    accepted.some((term) => words.some((word) => word.startsWith(term))),
  );
}

/**
 * How well a row answers the query, lower first: its name starting with the
 * query, then a name holding every word as typed, then a name matching through
 * alternatives, then a match only in its keywords. Within a tier, a row whose
 * name holds more of the words as typed comes first, so "dark mode" puts Dark
 * preset above Light preset, which matches only through "preset".
 */
function matchRank(
  label: string,
  keywords: string,
  normalizedQuery: string,
  terms: ReadonlyArray<ReadonlyArray<string>>,
  pageLabel = "",
): number {
  const name = normalizeSettingsQuery(label);
  const literal = terms.map((accepted) => accepted.slice(0, 1));
  const tier = name.startsWith(normalizedQuery)
    ? 0
    : matchesTerms(name, literal)
      ? 1
      : matchesTerms(name, terms)
        ? 2
        : 3;
  // The page's name counts as context: "delete data" prefers a row on Data &
  // privacy over one that only mentions data in passing.
  const own = `${name} ${normalizeSettingsQuery(keywords)} ${normalizeSettingsQuery(pageLabel)}`;
  const typedInName = literal.filter((term) => matchesTerms(name, [term])).length;
  const typedAnywhere = literal.filter((term) => matchesTerms(own, [term])).length;
  return tier * 100 - typedInName * 20 - typedAnywhere;
}

/**
 * Sections to render in the persistent left navigator.
 *
 * Empty query returns all available sections. A non-empty query returns only
 * sections whose label, keywords, or any contained *available* setting matches.
 */
export function filterSectionsForNavigator(
  availableSections: ReadonlyArray<SettingsSectionEntry>,
  capabilities: SettingsNativeCapabilities,
  query: string,
): ReadonlyArray<SettingsSectionEntry> {
  const normalized = normalizeSettingsQuery(query);
  if (normalized === "") return availableSections;
  return availableSections.filter((section) =>
    sectionMatchesQuery(section, capabilities, normalized),
  );
}

function sectionMatchesQuery(
  section: SettingsSectionEntry,
  capabilities: SettingsNativeCapabilities,
  normalized: string,
): boolean {
  const terms = queryTerms(normalized);
  if (matchesTerms(normalizeSettingsQuery(`${section.label} ${section.keywords}`), terms)) {
    return true;
  }
  return section.settings.some(
    (setting) =>
      isSettingAvailable(setting, capabilities) &&
      matchesTerms(normalizeSettingsQuery(`${setting.label} ${setting.keywords}`), terms),
  );
}

/**
 * Flat search results for the search-as-navigation panel.
 *
 * Empty query returns no results (the navigator handles unfiltered browsing).
 * A non-empty query returns matching *available* settings (with their section
 * reference), plus a section-level result when the section itself matches but
 * none of its available settings did — so opaque sections (e.g. Providers &
 * Models) stay discoverable. Settings gated by an unmet native capability are
 * excluded.
 */
export function searchSettings(
  availableSections: ReadonlyArray<SettingsSectionEntry>,
  capabilities: SettingsNativeCapabilities,
  query: string,
): ReadonlyArray<SettingsSearchResult> {
  const normalized = normalizeSettingsQuery(query);
  if (normalized === "") return [];
  const terms = queryTerms(normalized);
  const ranked: { readonly result: SettingsSearchResult; readonly rank: number }[] = [];
  for (const section of availableSections) {
    let settingMatched = false;
    for (const setting of section.settings) {
      if (!isSettingAvailable(setting, capabilities)) continue;
      // The page's name counts too, so "github sign out" finds GitHub's Log out,
      // but the row must answer at least one word itself: typing a page's name
      // alone finds the page, not every row on it.
      const own = normalizeSettingsQuery(`${setting.label} ${setting.keywords}`);
      if (!matchesTerms(`${own} ${normalizeSettingsQuery(section.label)}`, terms)) continue;
      if (!terms.some((term) => matchesTerms(own, [term]))) continue;
      settingMatched = true;
      ranked.push({
        result: {
          kind: "setting",
          sectionId: section.id,
          settingId: setting.id,
          label: setting.label,
          scope: setting.scope,
        },
        rank: matchRank(setting.label, setting.keywords, normalized, terms, section.label),
      });
    }
    if (settingMatched) continue;
    if (matchesTerms(normalizeSettingsQuery(`${section.label} ${section.keywords}`), terms)) {
      ranked.push({
        result: {
          kind: "section",
          sectionId: section.id,
          label: section.label,
          scope: section.scope,
        },
        // A whole page is a broader answer than one of its rows.
        rank: matchRank(section.label, section.keywords, normalized, terms) + 5,
      });
    }
  }
  // Array.prototype.sort is stable, so equal ranks keep the navigation order.
  return ranked.sort((left, right) => left.rank - right.rank).map((entry) => entry.result);
}

/**
 * Resolve a deep link against available sections.
 *
 * Returns undefined when the target section is unavailable (e.g. a native-only
 * section requested from the browser). When a setting is requested but not
 * found in that section, falls back to the section alone so the user still
 * lands on a useful destination.
 */
export function resolveDeepLink(
  registry: SettingsRegistry,
  capabilities: SettingsNativeCapabilities,
  link: SettingsDeepLink,
): SettingsResolvedDeepLink | undefined {
  const section = findSection(registry, link.section);
  if (section === undefined || !isSectionAvailable(section, capabilities)) return undefined;
  if (link.setting === undefined) return { section, settingId: undefined };
  const setting = findSetting(section, link.setting);
  if (setting === undefined) return { section, settingId: undefined };
  return { section, settingId: setting.id };
}
