import { useEffect, useRef, useState } from "react";
import type { SettingsDeepLink, SettingsSectionId } from "@octant/contracts";
import type { SettingsSearchResult } from "./registry";
import { scopeLabel } from "./primitives";

export interface SettingsSearchResultsProps {
  readonly query: string;
  readonly results: ReadonlyArray<SettingsSearchResult>;
  readonly sectionLabels: Readonly<Partial<Record<SettingsSectionId, string>>>;
  readonly onSelect: (link: SettingsDeepLink) => void;
  readonly onEscape?: () => void;
}

/**
 * Search-as-navigation panel.
 *
 * Lists matching settings (and opaque sections) as a keyboard-navigable
 * listbox. Selecting a result opens the section and focuses the exact control
 * via a {@link SettingsDeepLink}. No-results recovery is announced to
 * assistive tech through a `status` region.
 */
export function SettingsSearchResults({
  query,
  results,
  sectionLabels,
  onSelect,
  onEscape,
}: SettingsSearchResultsProps) {
  // -1 means no option is highlighted yet; the first ArrowDown lands on the
  // top result. When the result set changes (e.g. the user keeps typing), the
  // top result is pre-selected so Enter immediately opens it.
  const [activeIndex, setActiveIndex] = useState(-1);
  const listboxRef = useRef<HTMLUListElement>(null);
  const hasMounted = useRef(false);

  // Reset to the top result whenever the result set changes, but not on the
  // initial mount (the user has not interacted yet).
  useEffect(() => {
    if (!hasMounted.current) {
      hasMounted.current = true;
      return;
    }
    setActiveIndex(results.length === 0 ? -1 : 0);
  }, [results]);

  // Keep the active option scrolled into view during keyboard navigation.
  useEffect(() => {
    if (listboxRef.current === null) return;
    const active = listboxRef.current.querySelector<HTMLElement>('[aria-selected="true"]');
    active?.scrollIntoView?.({ block: "nearest" });
  }, [activeIndex]);

  const move = (delta: number) => {
    if (results.length === 0) return;
    setActiveIndex((current) => {
      if (current < 0) return delta > 0 ? 0 : results.length - 1;
      return (current + delta + results.length) % results.length;
    });
  };

  const selectActive = () => {
    if (activeIndex < 0) return;
    const result = results[activeIndex];
    if (result === undefined) return;
    onSelect(resultToDeepLink(result));
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLUListElement>) => {
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        move(1);
        break;
      case "ArrowUp":
        event.preventDefault();
        move(-1);
        break;
      case "Enter":
        event.preventDefault();
        selectActive();
        break;
      case "Home":
        event.preventDefault();
        setActiveIndex(results.length === 0 ? -1 : 0);
        break;
      case "End":
        event.preventDefault();
        setActiveIndex(results.length === 0 ? -1 : results.length - 1);
        break;
      case "Escape":
        event.preventDefault();
        onEscape?.();
        break;
    }
  };

  const isEmpty = query.trim() !== "" && results.length === 0;
  if (query.trim() === "") return null;
  if (isEmpty) {
    return (
      <p className="settings-search-results__empty" role="status">
        No settings match your search. Try a different term or browse the sections on the left.
      </p>
    );
  }

  return (
    <ul
      aria-label="Settings search results"
      aria-activedescendant={activeIndex < 0 ? undefined : optionId(activeIndex)}
      className="settings-search-results"
      onKeyDown={handleKeyDown}
      ref={listboxRef}
      role="listbox"
      tabIndex={0}
    >
      {results.map((result, index) => (
        <li
          aria-selected={index === activeIndex}
          className="settings-search-results__option"
          id={optionId(index)}
          key={resultKey(result)}
          onClick={() => onSelect(resultToDeepLink(result))}
          role="option"
        >
          <span className="settings-search-results__label">{resultLabel(result)}</span>
          <span className="settings-search-results__section">
            in {sectionLabels[result.sectionId] ?? result.sectionId}
          </span>
          <span className="settings-search-results__scope">{scopeLabel(result.scope)}</span>
        </li>
      ))}
    </ul>
  );
}

function optionId(index: number): string {
  return `settings-search-result-${index}`;
}

function resultKey(result: SettingsSearchResult): string {
  return result.kind === "setting" ? `setting:${result.settingId}` : `section:${result.sectionId}`;
}

function resultLabel(result: SettingsSearchResult): string {
  return result.label;
}

function resultToDeepLink(result: SettingsSearchResult): SettingsDeepLink {
  if (result.kind === "setting") {
    return { section: result.sectionId, setting: result.settingId };
  }
  return { section: result.sectionId };
}
