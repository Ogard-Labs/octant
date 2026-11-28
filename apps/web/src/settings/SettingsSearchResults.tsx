import { useEffect, useRef, useState } from "react";
import type { SettingsDeepLink, SettingsSectionId } from "@octant/contracts";
import { OctantListbox, OctantListboxOption, useOctantListbox } from "../ui/base/OctantListbox";
import { settingsQueryWords, type SettingsSearchResult } from "./registry";
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

  const listbox = useOctantListbox({
    activeIndex,
    count: results.length,
    getOptionLabel: (index) => {
      const result = results[index];
      return result === undefined ? "" : resultLabel(result);
    },
    onActivate: (index) => {
      const result = results[index];
      if (result !== undefined) onSelect(searchResultLink(result));
    },
    onActiveIndexChange: setActiveIndex,
    onDismiss: onEscape,
    stopEscapePropagation: true,
  });

  const queryWords = settingsQueryWords(query);
  const isEmpty = query.trim() !== "" && results.length === 0;
  if (query.trim() === "") return null;
  if (isEmpty) {
    return (
      <p className="settings-search-results__empty" role="status">
        No settings match “{query.trim()}”. Try another word, or browse the pages on the left.
      </p>
    );
  }

  return (
    <OctantListbox
      activeDescendantId={listbox.activeIndex < 0 ? undefined : optionId(listbox.activeIndex)}
      aria-label="Settings search results"
      as="ul"
      className="settings-search-results"
      onKeyDown={(event) => {
        listbox.handleKeyDown(event);
      }}
      tabIndex={0}
    >
      {results.map((result, index) => (
        <OctantListboxOption
          as="li"
          className="settings-search-results__option"
          id={optionId(index)}
          key={resultKey(result)}
          onClick={() => onSelect(searchResultLink(result))}
          selected={index === listbox.activeIndex}
        >
          <span className="settings-search-results__label">
            <MatchedLabel label={resultLabel(result)} words={queryWords} />
          </span>
          <span className="settings-search-results__section">
            in {sectionLabels[result.sectionId] ?? result.sectionId}
          </span>
          <span className="settings-search-results__scope">{scopeLabel(result.scope)}</span>
        </OctantListboxOption>
      ))}
    </OctantListbox>
  );
}

/**
 * The result's name with the start of each word the query matched marked, so
 * a person sees why it came up.
 */
function MatchedLabel(props: { readonly label: string; readonly words: ReadonlyArray<string> }) {
  const parts = props.label.split(/([\p{L}\p{N}]+)/u);
  return (
    <>
      {parts.map((part, index) => {
        const lower = part.toLocaleLowerCase();
        const word = props.words.find((candidate) => lower.startsWith(candidate));
        if (word === undefined || word.length === 0) return part;
        return (
          <span key={index}>
            <mark className="settings-search-results__match">{part.slice(0, word.length)}</mark>
            {part.slice(word.length)}
          </span>
        );
      })}
    </>
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

export function searchResultLink(result: SettingsSearchResult): SettingsDeepLink {
  if (result.kind === "setting") {
    return { section: result.sectionId, setting: result.settingId };
  }
  return { section: result.sectionId };
}
