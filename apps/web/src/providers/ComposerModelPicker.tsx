import type { ProviderInstanceId, ProviderModelId } from "@octant/contracts";
import type { ModelPickerSelection, PickerGroup, PickerModel } from "@octant/domain";
import { ChevronDown, Search } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState } from "react";

export interface ComposerModelPickerProps {
  readonly groups: ReadonlyArray<PickerGroup>;
  readonly selectedProviderInstanceId?: ProviderInstanceId;
  readonly selectedModelId?: ProviderModelId;
  readonly onSelect: (selection: ModelPickerSelection) => void;
  readonly onOpenSettings?: () => void;
  readonly disabled?: boolean;
  readonly ariaLabel?: string;
}

export function ComposerModelPicker(props: ComposerModelPickerProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);
  const menuId = useId();
  const ariaLabel = props.ariaLabel ?? "Provider and model";

  const selectedGroup = useMemo(
    () =>
      props.groups.find((group) => group.instance.id === props.selectedProviderInstanceId) ??
      props.groups[0],
    [props.groups, props.selectedProviderInstanceId],
  );
  const [activeProviderId, setActiveProviderId] = useState<ProviderInstanceId | undefined>(
    selectedGroup?.instance.id,
  );

  useEffect(() => {
    if (!open) return;
    setActiveProviderId(selectedGroup?.instance.id ?? props.groups[0]?.instance.id);
  }, [open, props.groups, selectedGroup?.instance.id]);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: PointerEvent) {
      if (rootRef.current === null) return;
      if (event.target instanceof Node && rootRef.current.contains(event.target)) return;
      setOpen(false);
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  if (props.groups.length === 0) {
    return (
      <div className="composer-model-picker composer-model-picker--empty">
        <button
          aria-label={ariaLabel}
          className="composer-model-picker__trigger window-no-drag"
          disabled={props.disabled || props.onOpenSettings === undefined}
          onClick={props.onOpenSettings}
          title={
            props.onOpenSettings === undefined
              ? "Configure and check a provider in Settings."
              : "Open provider settings"
          }
          type="button"
        >
          <span className="composer-model-picker__trigger-label">No provider ready</span>
          <ChevronDown aria-hidden="true" className="composer-model-picker__chevron" size={12} />
        </button>
      </div>
    );
  }

  const activeGroup =
    props.groups.find((group) => group.instance.id === activeProviderId) ?? props.groups[0]!;
  const selectedLabel =
    selectedModelLabel(props.groups, props.selectedProviderInstanceId, props.selectedModelId) ??
    activeGroup.sections[0]?.models[0]?.model.displayName ??
    activeGroup.instance.displayName;
  const trimmedQuery = query.trim().toLowerCase();
  // With a search query, matches span every provider; otherwise the list
  // shows the active provider's models.
  const models =
    trimmedQuery === ""
      ? flattenModels(activeGroup).map((entry) => ({ ...entry, group: activeGroup }))
      : props.groups.flatMap((group) =>
          flattenModels(group)
            .filter((entry) => entry.picker.model.displayName.toLowerCase().includes(trimmedQuery))
            .map((entry) => ({ ...entry, group })),
        );

  return (
    <div
      className={`composer-model-picker${open ? " composer-model-picker--open" : ""}`}
      ref={rootRef}
    >
      <button
        aria-controls={menuId}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={ariaLabel}
        className="composer-model-picker__trigger window-no-drag"
        disabled={props.disabled}
        onClick={() =>
          setOpen((current) => {
            if (!current) setQuery("");
            return !current;
          })
        }
        type="button"
      >
        <span className="composer-model-picker__trigger-label">{selectedLabel}</span>
        <ChevronDown aria-hidden="true" className="composer-model-picker__chevron" size={12} />
      </button>
      {!open ? null : (
        <div
          aria-label="Choose provider and model"
          className="composer-model-picker__menu"
          id={menuId}
          role="dialog"
        >
          <label className="composer-model-picker__search">
            <Search aria-hidden="true" size={13} />
            <input
              aria-label="Search models"
              onChange={(event) => setQuery(event.currentTarget.value)}
              placeholder="Search models…"
              type="search"
              value={query}
            />
          </label>
          <div className="composer-model-picker__panes">
            <div aria-label="Providers" className="composer-model-picker__providers" role="listbox">
              {props.groups.map((group) => {
                const selected = group.instance.id === activeGroup.instance.id;
                const status = readinessStatus(group.readiness);
                return (
                  <button
                    aria-label={group.instance.displayName}
                    aria-selected={selected && trimmedQuery === ""}
                    className={`composer-model-picker__provider${selected && trimmedQuery === "" ? " composer-model-picker__provider--active" : ""}`}
                    key={String(group.instance.id)}
                    onClick={() => {
                      setQuery("");
                      setActiveProviderId(group.instance.id);
                    }}
                    onMouseEnter={() => {
                      if (trimmedQuery === "") setActiveProviderId(group.instance.id);
                    }}
                    role="option"
                    type="button"
                  >
                    <span aria-hidden="true" className="composer-model-picker__provider-glyph">
                      {monogram(group.instance.displayName)}
                    </span>
                    <span className="composer-model-picker__provider-name">
                      {group.instance.displayName}
                    </span>
                    {status === undefined ? null : (
                      <span className="composer-model-picker__provider-status">{status}</span>
                    )}
                  </button>
                );
              })}
            </div>
            <div aria-label="Models" className="composer-model-picker__models" role="listbox">
              {models.length === 0 ? (
                <p className="composer-model-picker__models-empty" role="status">
                  {trimmedQuery === ""
                    ? "No models reported for this provider."
                    : "No models match the search."}
                </p>
              ) : (
                models.map(({ picker, sectionLabel, group }) => {
                  const modelId = picker.model.id;
                  const selected =
                    props.selectedProviderInstanceId === group.instance.id &&
                    props.selectedModelId === modelId;
                  const unavailable = picker.unavailableReason !== undefined;
                  return (
                    <button
                      aria-label={picker.model.displayName}
                      aria-selected={selected}
                      className={`composer-model-picker__model${selected ? " composer-model-picker__model--selected" : ""}${unavailable ? " composer-model-picker__model--unavailable" : ""}`}
                      disabled={unavailable || props.disabled}
                      key={`${String(group.instance.id)}:${sectionLabel}:${String(modelId)}`}
                      onClick={() => {
                        if (unavailable) return;
                        props.onSelect({
                          providerInstanceId: group.instance.id,
                          modelId,
                        });
                        setOpen(false);
                      }}
                      role="option"
                      title={picker.unavailableReason}
                      type="button"
                    >
                      <span className="composer-model-picker__model-copy">
                        <span className="composer-model-picker__model-name">
                          {picker.model.displayName}
                        </span>
                        <span className="composer-model-picker__model-detail">
                          {group.instance.displayName} · {sectionLabel}
                        </span>
                      </span>
                      {unavailable ? (
                        <span className="composer-model-picker__model-badge">
                          {compactUnavailableLabel(picker.unavailableReason)}
                        </span>
                      ) : null}
                    </button>
                  );
                })
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function monogram(displayName: string): string {
  const words = displayName.trim().split(/\s+/);
  const first = words[0]?.[0] ?? "?";
  const second = words[1]?.[0] ?? "";
  return `${first}${second}`.toUpperCase();
}

function flattenModels(
  group: PickerGroup,
): ReadonlyArray<{ readonly picker: PickerModel; readonly sectionLabel: string }> {
  return group.sections.flatMap((section) =>
    section.models.map((picker) => ({ picker, sectionLabel: section.label })),
  );
}

function selectedModelLabel(
  groups: ReadonlyArray<PickerGroup>,
  providerInstanceId: ProviderInstanceId | undefined,
  modelId: ProviderModelId | undefined,
): string | undefined {
  if (providerInstanceId === undefined || modelId === undefined) return undefined;
  const group = groups.find((entry) => entry.instance.id === providerInstanceId);
  if (group === undefined) return undefined;
  for (const section of group.sections) {
    const match = section.models.find((picker) => picker.model.id === modelId);
    if (match !== undefined) return match.model.displayName;
  }
  return group.unavailableCurrent?.model.displayName;
}

function readinessStatus(readiness: PickerGroup["readiness"]): string | undefined {
  switch (readiness) {
    case "degraded":
      return "Degraded";
    case "unauthenticated":
      return "Sign in";
    case "unavailable":
    case "incompatible":
    case "checking":
      return "Unavailable";
    case "ready":
      return undefined;
  }
}

function compactUnavailableLabel(reason: string | undefined): string {
  if (reason === undefined) return "Unavailable";
  if (/tool calling/i.test(reason)) return "Chat only";
  if (/no longer listed/i.test(reason)) return "Unavailable";
  if (/not available/i.test(reason)) return "Unavailable";
  return "Limited";
}
