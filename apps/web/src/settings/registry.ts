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

function matchesQuery(haystack: string, normalizedQuery: string): boolean {
  return normalizedQuery === "" || haystack.includes(normalizedQuery);
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
  if (matchesQuery(normalizeSettingsQuery(`${section.label} ${section.keywords}`), normalized)) {
    return true;
  }
  return section.settings.some(
    (setting) =>
      isSettingAvailable(setting, capabilities) &&
      matchesQuery(normalizeSettingsQuery(`${setting.label} ${setting.keywords}`), normalized),
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
  const results: SettingsSearchResult[] = [];
  for (const section of availableSections) {
    const settingMatches: SettingsSearchResult[] = [];
    for (const setting of section.settings) {
      if (!isSettingAvailable(setting, capabilities)) continue;
      if (
        matchesQuery(normalizeSettingsQuery(`${setting.label} ${setting.keywords}`), normalized)
      ) {
        settingMatches.push({
          kind: "setting",
          sectionId: section.id,
          settingId: setting.id,
          label: setting.label,
          scope: setting.scope,
        });
      }
    }
    if (settingMatches.length > 0) {
      results.push(...settingMatches);
      continue;
    }
    if (matchesQuery(normalizeSettingsQuery(`${section.label} ${section.keywords}`), normalized)) {
      results.push({
        kind: "section",
        sectionId: section.id,
        label: section.label,
        scope: section.scope,
      });
    }
  }
  return results;
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
