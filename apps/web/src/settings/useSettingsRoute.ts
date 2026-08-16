import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { SettingsDeepLink, SettingsSectionId, SettingsSettingId } from "@octant/contracts";
import {
  type SettingsNativeCapabilities,
  type SettingsRegistry,
  type SettingsSectionEntry,
  findSetting,
  resolveDeepLink,
} from "./registry";

export interface SettingsRouteController {
  readonly activeSection: SettingsSectionId;
  readonly focusedSetting: SettingsSettingId | undefined;
  readonly openSection: (sectionId: SettingsSectionId) => void;
  readonly focusSetting: (settingId: SettingsSettingId | undefined) => void;
  readonly applyDeepLink: (link: SettingsDeepLink) => void;
  readonly clearFocus: () => void;
}

export interface UseSettingsRouteOptions {
  readonly availableSections: ReadonlyArray<SettingsSectionEntry>;
  readonly capabilities: SettingsNativeCapabilities;
  readonly registry: SettingsRegistry;
  readonly initialDeepLink?: SettingsDeepLink | undefined;
}

/**
 * Durable Settings route/view state.
 *
 * Owns the active section (one coherent section at a time, not a long scroll)
 * and the focused setting (the deep-link destination). Deep links from other
 * app surfaces are applied through {@link SettingsRouteController.applyDeepLink}
 * or as an `initialDeepLink` on mount.
 */
export function useSettingsRoute(options: UseSettingsRouteOptions): SettingsRouteController {
  const { availableSections, capabilities, registry, initialDeepLink } = options;
  const firstSection = availableSections[0]?.id;

  const computeInitial = (): SettingsSectionId => {
    if (initialDeepLink !== undefined) {
      const resolved = resolveDeepLink(registry, capabilities, initialDeepLink);
      if (resolved !== undefined) return resolved.section.id;
    }
    return firstSection ?? "general";
  };

  const [activeSection, setActiveSection] = useState<SettingsSectionId>(computeInitial);
  const [focusedSetting, setFocusedSetting] = useState<SettingsSettingId | undefined>(undefined);

  // Clamp the active section to an available one when availability changes
  // (e.g. a native capability is reported as unsupported, or the registry
  // narrows). Keeps focus consistent with what can be shown.
  useEffect(() => {
    const stillAvailable = availableSections.some((section) => section.id === activeSection);
    if (!stillAvailable) {
      setActiveSection(firstSection ?? "general");
      setFocusedSetting(undefined);
    }
  }, [availableSections, activeSection, firstSection]);

  // Apply the initial deep link's setting focus once on mount.
  const appliedInitial = useRef(false);
  useEffect(() => {
    if (appliedInitial.current) return;
    appliedInitial.current = true;
    if (initialDeepLink === undefined) return;
    const resolved = resolveDeepLink(registry, capabilities, initialDeepLink);
    if (resolved?.settingId !== undefined) {
      setFocusedSetting(resolved.settingId);
    }
  }, [initialDeepLink, registry, capabilities]);

  const openSection = useCallback(
    (sectionId: SettingsSectionId) => {
      if (!availableSections.some((section) => section.id === sectionId)) return;
      setActiveSection(sectionId);
      setFocusedSetting(undefined);
    },
    [availableSections],
  );

  const focusSetting = useCallback((settingId: SettingsSettingId | undefined) => {
    setFocusedSetting(settingId);
  }, []);

  const clearFocus = useCallback(() => setFocusedSetting(undefined), []);

  const applyDeepLink = useCallback(
    (link: SettingsDeepLink) => {
      const resolved = resolveDeepLink(registry, capabilities, link);
      if (resolved === undefined) return;
      setActiveSection(resolved.section.id);
      setFocusedSetting(resolved.settingId);
    },
    [registry, capabilities],
  );

  return useMemo(
    () => ({
      activeSection,
      focusedSetting,
      openSection,
      focusSetting,
      applyDeepLink,
      clearFocus,
    }),
    [activeSection, focusedSetting, openSection, focusSetting, applyDeepLink, clearFocus],
  );
}

// Re-export so consumers can resolve a setting entry from the active section.
export { findSetting };
