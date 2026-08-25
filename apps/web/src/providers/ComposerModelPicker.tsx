import type { ProviderInstanceId, ProviderModelId } from "@octant/contracts";
import type { ModelPickerSelection, PickerGroup, PickerModel } from "@octant/domain";
import { ChevronDown, Search, Star } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import {
  modelFavoriteKey,
  readModelFavorites,
  toggleModelFavorite,
  writeModelFavorites,
} from "./modelFavorites";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantInput } from "../ui/base/OctantInput";
import { ProviderGlyph } from "./ProviderGlyph";

export interface ComposerModelPickerProps {
  readonly groups: ReadonlyArray<PickerGroup>;
  readonly selectedProviderInstanceId?: ProviderInstanceId;
  readonly selectedModelId?: ProviderModelId;
  readonly onSelect: (selection: ModelPickerSelection) => void;
  readonly onOpenSettings?: () => void;
  readonly disabled?: boolean;
  readonly ariaLabel?: string;
}

const FAVORITES_RAIL_ID = "favorites";
type RailId = ProviderInstanceId | typeof FAVORITES_RAIL_ID;

interface ModelRow {
  readonly picker: PickerModel;
  readonly sectionId: string;
  readonly sectionLabel: string;
  readonly group: PickerGroup;
}

export function ComposerModelPicker(props: ComposerModelPickerProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [favorites, setFavorites] = useState<ReadonlySet<string>>(() => readModelFavorites());
  const rootRef = useRef<HTMLDivElement>(null);
  const menuId = useId();
  const ariaLabel = props.ariaLabel ?? "Provider and model";

  const selectedGroup = useMemo(
    () =>
      props.groups.find((group) => group.instance.id === props.selectedProviderInstanceId) ??
      props.groups[0],
    [props.groups, props.selectedProviderInstanceId],
  );
  const [activeRailId, setActiveRailId] = useState<RailId | undefined>(selectedGroup?.instance.id);

  useEffect(() => {
    if (!open) return;
    setActiveRailId(selectedGroup?.instance.id ?? props.groups[0]?.instance.id);
    setFavorites(readModelFavorites());
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
        <OctantButton
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
          variant="ghost"
        >
          <span className="composer-model-picker__trigger-label">No provider ready</span>
          <ChevronDown aria-hidden="true" className="composer-model-picker__chevron" size={12} />
        </OctantButton>
      </div>
    );
  }

  const activeGroup =
    props.groups.find((group) => group.instance.id === activeRailId) ?? props.groups[0]!;
  const selectedLabel =
    selectedModelLabel(props.groups, props.selectedProviderInstanceId, props.selectedModelId) ??
    activeGroup.sections[0]?.models[0]?.model.displayName ??
    activeGroup.instance.displayName;
  const trimmedQuery = query.trim().toLowerCase();
  const searching = trimmedQuery !== "";
  const favoritesActive = !searching && activeRailId === FAVORITES_RAIL_ID;
  // With a search query, matches span every provider; the Favorites rail entry
  // lists starred models across providers; otherwise the list shows the active
  // provider's models.
  const models: ReadonlyArray<ModelRow> = searching
    ? props.groups.flatMap((group) =>
        flattenModels(group).filter((row) =>
          row.picker.model.displayName.toLowerCase().includes(trimmedQuery),
        ),
      )
    : favoritesActive
      ? props.groups.flatMap((group) =>
          flattenModels(group).filter((row) =>
            favorites.has(modelFavoriteKey(group.instance.id, row.picker.model.id)),
          ),
        )
      : flattenModels(activeGroup);

  function toggleFavorite(key: string) {
    setFavorites((current) => {
      const next = toggleModelFavorite(current, key);
      writeModelFavorites(next);
      return next;
    });
  }

  return (
    <div
      className={`composer-model-picker${open ? " composer-model-picker--open" : ""}`}
      ref={rootRef}
    >
      <OctantButton
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
        variant="ghost"
      >
        <span className="composer-model-picker__trigger-label">{selectedLabel}</span>
        <ChevronDown aria-hidden="true" className="composer-model-picker__chevron" size={12} />
      </OctantButton>
      {!open ? null : (
        <div
          aria-label="Choose provider and model"
          className="composer-model-picker__menu"
          id={menuId}
          role="dialog"
        >
          <div aria-label="Providers" className="composer-model-picker__rail" role="listbox">
            <OctantButton
              aria-label="Favorites"
              aria-selected={favoritesActive}
              className={`composer-model-picker__rail-item composer-model-picker__rail-item--favorites${favoritesActive ? " composer-model-picker__rail-item--active" : ""}`}
              onClick={() => {
                setQuery("");
                setActiveRailId(FAVORITES_RAIL_ID);
              }}
              role="option"
              title="Favorites"
              type="button"
              variant="ghost"
            >
              <Star aria-hidden="true" fill="currentColor" size={16} strokeWidth={1.75} />
            </OctantButton>
            <span aria-hidden="true" className="composer-model-picker__rail-divider" />
            {props.groups.map((group) => {
              const active = !searching && group.instance.id === activeRailId;
              const status = readinessStatus(group.readiness);
              return (
                <OctantButton
                  aria-label={group.instance.displayName}
                  aria-selected={active}
                  className={`composer-model-picker__rail-item${active ? " composer-model-picker__rail-item--active" : ""}`}
                  key={String(group.instance.id)}
                  onClick={() => {
                    setQuery("");
                    setActiveRailId(group.instance.id);
                  }}
                  onMouseEnter={() => {
                    if (!searching) setActiveRailId(group.instance.id);
                  }}
                  role="option"
                  title={group.instance.displayName}
                  type="button"
                  variant="ghost"
                >
                  <ProviderGlyph
                    displayName={group.instance.displayName}
                    driverKind={group.instance.driverKind}
                    size={16}
                  />
                  {status === undefined ? null : (
                    <span
                      className={`composer-model-picker__rail-status composer-model-picker__rail-status--${group.readiness}`}
                      title={status}
                    >
                      <span className="sr-only">{status}</span>
                    </span>
                  )}
                </OctantButton>
              );
            })}
          </div>
          <div className="composer-model-picker__pane">
            <label className="composer-model-picker__search">
              <Search aria-hidden="true" size={14} />
              <OctantInput
                aria-label="Search models"
                onChange={(event) => setQuery(event.currentTarget.value)}
                placeholder="Search models…"
                type="search"
                value={query}
              />
            </label>
            <div aria-label="Models" className="composer-model-picker__models" role="listbox">
              {models.length === 0 ? (
                <p className="composer-model-picker__models-empty" role="status">
                  {searching
                    ? "No models match the search."
                    : favoritesActive
                      ? "No favorites yet. Star a model to keep it here."
                      : "No models reported for this provider."}
                </p>
              ) : (
                models.map(({ picker, sectionId, sectionLabel, group }) => {
                  const modelId = picker.model.id;
                  const favoriteKey = modelFavoriteKey(group.instance.id, modelId);
                  const favorited = favorites.has(favoriteKey);
                  const selected =
                    props.selectedProviderInstanceId === group.instance.id &&
                    props.selectedModelId === modelId;
                  const unavailable = picker.unavailableReason !== undefined;
                  // The generic "all models" section adds nothing next to the
                  // provider name; only informative sections get a suffix.
                  const detail =
                    sectionId === "all-models" || sectionLabel === group.instance.displayName
                      ? group.instance.displayName
                      : `${group.instance.displayName} · ${sectionLabel}`;
                  return (
                    <div
                      className={`composer-model-picker__row${selected ? " composer-model-picker__row--selected" : ""}`}
                      key={`${String(group.instance.id)}:${sectionLabel}:${String(modelId)}`}
                    >
                      <OctantButton
                        aria-label={picker.model.displayName}
                        aria-selected={selected}
                        className={`composer-model-picker__model${selected ? " composer-model-picker__model--selected" : ""}${unavailable ? " composer-model-picker__model--unavailable" : ""}`}
                        disabled={unavailable || props.disabled}
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
                        variant="ghost"
                      >
                        <span className="composer-model-picker__model-copy">
                          <span className="composer-model-picker__model-name">
                            {picker.model.displayName}
                          </span>
                          <span className="composer-model-picker__model-detail">
                            <ProviderGlyph
                              displayName={group.instance.displayName}
                              driverKind={group.instance.driverKind}
                              size={12}
                            />
                            {detail}
                          </span>
                        </span>
                        {unavailable ? (
                          <span className="composer-model-picker__model-badge">
                            {compactUnavailableLabel(picker.unavailableReason)}
                          </span>
                        ) : null}
                      </OctantButton>
                      <OctantButton
                        aria-label={favorited ? "Remove from favorites" : "Add to favorites"}
                        aria-pressed={favorited}
                        className={`composer-model-picker__star${favorited ? " composer-model-picker__star--on" : ""}`}
                        onClick={(event) => {
                          event.stopPropagation();
                          toggleFavorite(favoriteKey);
                        }}
                        title={favorited ? "Remove from favorites" : "Add to favorites"}
                        type="button"
                        variant="ghost"
                      >
                        <Star
                          aria-hidden="true"
                          fill={favorited ? "currentColor" : "none"}
                          size={14}
                          strokeWidth={1.75}
                        />
                      </OctantButton>
                    </div>
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

function flattenModels(group: PickerGroup): ReadonlyArray<ModelRow> {
  return group.sections.flatMap((section) =>
    section.models.map((picker) => ({
      picker,
      sectionId: section.id,
      sectionLabel: section.label,
      group,
    })),
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
