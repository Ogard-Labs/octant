import type { ExecutionContextPickerEntry } from "@octant/contracts/agent-profile";
import { useMemo, useRef, useState, type KeyboardEvent } from "react";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantInput } from "../ui/base/OctantInput";

export interface ExecutionContextPickerProps {
  readonly entries: ReadonlyArray<ExecutionContextPickerEntry>;
  readonly selectedEntry?: ExecutionContextPickerEntry;
  readonly onSelect: (entry: ExecutionContextPickerEntry) => void;
  readonly disabled?: boolean;
}

export function ExecutionContextPicker(props: ExecutionContextPickerProps) {
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(-1);
  const listRef = useRef<HTMLDivElement>(null);

  const filtered = useMemo(() => {
    const trimmed = query.trim().toLowerCase();
    if (trimmed === "") return props.entries;
    return props.entries.filter((entry) => {
      const text = [
        entry.providerDisplayName,
        entry.modelDisplayName,
        entry.profileDisplayName ?? "",
        entry.hostLabel,
      ]
        .join(" ")
        .toLowerCase();
      return text.includes(trimmed);
    });
  }, [props.entries, query]);

  const availableEntries = useMemo(
    () => filtered.filter((e) => e.unavailableReason === undefined),
    [filtered],
  );

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (availableEntries.length === 0) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex((i) => (i + 1 >= availableEntries.length ? 0 : i + 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((i) => (i - 1 < 0 ? availableEntries.length - 1 : i - 1));
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      const entry = availableEntries[activeIndex];
      if (entry !== undefined) {
        props.onSelect(entry);
      }
    }
  }

  return (
    <div className="execution-context-picker" aria-label="Execution context">
      <OctantInput
        aria-label="Search providers, models, and profiles"
        className="execution-context-picker__search window-no-drag"
        disabled={props.disabled}
        onChange={(e) => {
          setQuery(e.target.value);
          setActiveIndex(-1);
        }}
        placeholder="Search providers, models, profiles…"
        role="searchbox"
        type="search"
        value={query}
      />
      {filtered.length === 0 ? (
        <p className="execution-context-picker__empty" role="status">
          {props.entries.length === 0
            ? "No providers available. Configure and probe a provider in Settings."
            : "No entries match your search."}
        </p>
      ) : (
        <div
          aria-label="Execution context options"
          className="execution-context-picker__listbox"
          onKeyDown={handleKeyDown}
          ref={listRef}
          role="listbox"
          tabIndex={props.disabled ? -1 : 0}
        >
          {filtered.map((entry) => {
            const isAvailable = entry.unavailableReason === undefined;
            const isActive = availableEntries[activeIndex] === entry;
            const isSelected =
              props.selectedEntry !== undefined &&
              props.selectedEntry.providerInstanceId === entry.providerInstanceId &&
              props.selectedEntry.modelId === entry.modelId &&
              props.selectedEntry.profileId === entry.profileId;
            return (
              // A plain button, not the `.btn` recipe: the recipe centers one
              // non-wrapping label at a fixed control height, which clipped
              // model names against the card's bottom border. This row is
              // content-sized so provider, model, and facts always fit.
              <OctantButton
                aria-disabled={!isAvailable}
                aria-selected={isSelected}
                className={`execution-context-picker__option${isActive ? " execution-context-picker__option--active" : ""}${isSelected ? " execution-context-picker__option--selected" : ""}`}
                disabled={props.disabled || !isAvailable}
                key={`${String(entry.providerInstanceId)}-${String(entry.modelId)}-${entry.profileId ?? "none"}`}
                onClick={() => isAvailable && props.onSelect(entry)}
                role="option"
                type="button"
                variant="ghost"
              >
                <span className="execution-context-picker__option-main">
                  <span className="execution-context-picker__provider">
                    {entry.providerDisplayName}
                  </span>
                  <span className="execution-context-picker__model">{entry.modelDisplayName}</span>
                  {entry.profileDisplayName !== undefined ? (
                    <span className="execution-context-picker__profile">
                      {entry.profileDisplayName}
                    </span>
                  ) : null}
                </span>
                <span className="execution-context-picker__option-meta">
                  {[
                    entry.hostLabel,
                    policyLabel(entry.executionPolicy),
                    permissionSummary(entry.effectivePermissions),
                  ].join(" · ")}
                </span>
                {entry.unavailableReason !== undefined ? (
                  <span className="execution-context-picker__unavailable">
                    {entry.unavailableReason}
                  </span>
                ) : null}
              </OctantButton>
            );
          })}
        </div>
      )}
    </div>
  );
}

function policyLabel(policy: string): string {
  return policy === "plan"
    ? "Plan"
    : policy === "approval-gated"
      ? "Approval"
      : policy === "auto-accept-edits"
        ? "Auto edits"
        : "Full";
}

function permissionSummary(
  permissions: ExecutionContextPickerEntry["effectivePermissions"],
): string {
  const items: string[] = [];
  if (permissions.filesystem) items.push("FS");
  if (permissions.shell) items.push("Shell");
  if (permissions.git) items.push("Git");
  if (permissions.tools) items.push("Tools");
  if (permissions.network) items.push("Net");
  if (permissions.subagents) items.push("Sub");
  return items.length === 0 ? "Read-only" : items.join(" · ");
}
