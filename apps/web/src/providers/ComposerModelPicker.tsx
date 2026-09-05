import type { ProviderInstanceId, ProviderModelId } from "@octant/contracts";
import type { ModelPickerSelection, PickerGroup, PickerModel } from "@octant/domain";
import { pickerCatalogs } from "@octant/domain";
import { ChevronDown, Search, Star } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import {
  modelFavoriteKey,
  readModelFavorites,
  toggleModelFavorite,
  writeModelFavorites,
} from "./modelFavorites";
import { OctantBadge } from "../ui/base/OctantBadge";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantInput } from "../ui/base/OctantInput";
import { OctantPopover } from "../ui/base/OctantPopover";
import { OctantSeparator } from "../ui/base/OctantSeparator";
import { ProviderGlyph } from "./ProviderGlyph";

export interface ComposerModelPickerProps {
  readonly groups: ReadonlyArray<PickerGroup>;
  readonly selectedProviderInstanceId?: ProviderInstanceId;
  readonly selectedModelId?: ProviderModelId;
  readonly onSelect: (selection: ModelPickerSelection) => void;
  readonly onOpenSettings?: () => void;
  /** Opens Settings → Octant Harness, shown from the Octant entry. */
  readonly onOpenHarnessSettings?: () => void;
  readonly disabled?: boolean;
  readonly ariaLabel?: string;
  /**
   * Which side of the trigger the menu opens on. Most composers sit at the
   * bottom of their view, so the menu opens upward by default; a composer
   * that sits mid-screen (Work/Code composer bars, the Chat welcome and
   * Project quick-start forms) passes "bottom" so it opens downward instead.
   */
  readonly menuSide?: "top" | "bottom";
}

const FAVORITES_RAIL_ID = "favorites";
/** One rail entry for every endpoint the native harness drives. */
const OCTANT_RAIL_ID = "octant-harness";
type RailId = ProviderInstanceId | typeof FAVORITES_RAIL_ID | typeof OCTANT_RAIL_ID;

function railIdFor(group: PickerGroup | undefined): RailId | undefined {
  if (group === undefined) return undefined;
  return group.runtime === "octant-harness" ? OCTANT_RAIL_ID : group.instance.id;
}

interface ModelRow {
  readonly picker: PickerModel;
  readonly sectionId: string;
  readonly sectionLabel: string;
  readonly group: PickerGroup;
}

export function ComposerModelPicker(props: ComposerModelPickerProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [catalogFilter, setCatalogFilter] = useState<string | undefined>(undefined);
  const [favorites, setFavorites] = useState<ReadonlySet<string>>(() => readModelFavorites());
  const ariaLabel = props.ariaLabel ?? "Provider and model";

  const selectedGroup = useMemo(
    () =>
      props.groups.find((group) => group.instance.id === props.selectedProviderInstanceId) ??
      props.groups[0],
    [props.groups, props.selectedProviderInstanceId],
  );
  const [activeRailId, setActiveRailId] = useState<RailId | undefined>(railIdFor(selectedGroup));
  const harnessGroups = useMemo(
    () => props.groups.filter((group) => group.runtime === "octant-harness"),
    [props.groups],
  );
  const railGroups = useMemo(
    () => props.groups.filter((group) => group.runtime !== "octant-harness"),
    [props.groups],
  );
  // The Octant entry sits where the first harness endpoint sat in the user's
  // provider order, so folding endpoints together does not move Octant to
  // the front or the back on its own.
  const octantRailIndex = props.groups.findIndex((group) => group.runtime === "octant-harness");

  useEffect(() => {
    if (!open) return;
    setActiveRailId(railIdFor(selectedGroup) ?? railIdFor(props.groups[0]));
    setCatalogFilter(undefined);
    setFavorites(readModelFavorites());
  }, [open, props.groups, selectedGroup?.instance.id]);

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

  const trimmedQuery = query.trim().toLowerCase();
  const searching = trimmedQuery !== "";
  const octantActive = !searching && activeRailId === OCTANT_RAIL_ID;
  const activeGroup =
    props.groups.find((group) => group.instance.id === activeRailId) ??
    (activeRailId === OCTANT_RAIL_ID ? harnessGroups[0] : undefined) ??
    props.groups[0]!;
  const selectedLabel =
    selectedModelLabel(props.groups, props.selectedProviderInstanceId, props.selectedModelId) ??
    activeGroup.sections[0]?.models[0]?.model.displayName ??
    activeGroup.instance.displayName;
  const favoritesActive = !searching && activeRailId === FAVORITES_RAIL_ID;
  // With a search query, matches span every provider; the Favorites rail entry
  // lists starred models across providers; otherwise the list shows the active
  // provider's models.
  const allModels: ReadonlyArray<ModelRow> = searching
    ? props.groups.flatMap((group) =>
        flattenModels(group).filter((row) => matchesQuery(row, trimmedQuery)),
      )
    : favoritesActive
      ? props.groups.flatMap((group) =>
          flattenModels(group).filter((row) =>
            favorites.has(modelFavoriteKey(group.instance.id, row.picker.model.id)),
          ),
        )
      : octantActive
        ? harnessGroups.flatMap((group) => flattenModels(group))
        : flattenModels(activeGroup);
  // One OpenCode or router instance fronts many upstream catalogs, so its pane
  // is where "which of these hundred models is a Qwen model" gets answered. A
  // provider serving a single catalog gains nothing from the split.
  const catalogs = searching || favoritesActive || octantActive ? [] : pickerCatalogs(activeGroup);
  const filteringCatalog = catalogs.length > 1 ? catalogFilter : undefined;
  const models: ReadonlyArray<ModelRow> =
    filteringCatalog === undefined
      ? allModels
      : allModels.filter((row) => row.picker.catalog === filteringCatalog);
  const blocks: ReadonlyArray<{
    readonly catalog: string | undefined;
    readonly rows: ReadonlyArray<ModelRow>;
  }> = octantActive
    ? groupByEndpoint(models)
    : catalogs.length > 1 && filteringCatalog === undefined
      ? groupByCatalog(models, catalogs)
      : [{ catalog: undefined, rows: models }];

  function toggleFavorite(key: string) {
    setFavorites((current) => {
      const next = toggleModelFavorite(current, key);
      writeModelFavorites(next);
      return next;
    });
  }

  function renderModelRow(row: ModelRow, showCatalog: boolean) {
    const { picker, sectionId, sectionLabel, group } = row;
    const modelId = picker.model.id;
    const favoriteKey = modelFavoriteKey(group.instance.id, modelId);
    const favorited = favorites.has(favoriteKey);
    const selected =
      props.selectedProviderInstanceId === group.instance.id && props.selectedModelId === modelId;
    const unavailable = picker.unavailableReason !== undefined;
    // The generic "all models" section adds nothing next to the provider name;
    // only informative sections get a suffix. The catalog is left out when a
    // heading directly above the row already names it.
    const detail = [
      group.instance.displayName,
      showCatalog ? picker.catalog : undefined,
      sectionId === "all-models" || sectionLabel === group.instance.displayName
        ? undefined
        : sectionLabel,
    ]
      .filter((part): part is string => part !== undefined)
      .join(" · ");
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
            props.onSelect({ providerInstanceId: group.instance.id, modelId });
            setOpen(false);
          }}
          role="option"
          title={picker.unavailableReason}
          type="button"
          variant="ghost"
        >
          <span className="composer-model-picker__model-copy">
            <span className="composer-model-picker__model-name">{picker.model.displayName}</span>
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
            <OctantBadge className="composer-model-picker__model-badge" variant="secondary">
              {compactUnavailableLabel(picker.unavailableReason)}
            </OctantBadge>
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
  }

  function renderRailItem(group: PickerGroup) {
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
          setCatalogFilter(undefined);
          setActiveRailId(group.instance.id);
        }}
        onMouseEnter={() => {
          if (searching) return;
          // Moving across the rail lands on a different catalog set, so
          // a filter chosen for the provider you left must not silently
          // hide models on the one you arrived at.
          if (group.instance.id !== activeRailId) setCatalogFilter(undefined);
          setActiveRailId(group.instance.id);
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
  }

  function renderOctantRailItem() {
    const active = octantActive;
    const worst = harnessGroups.map((group) => readinessStatus(group.readiness)).find(Boolean);
    return (
      <OctantButton
        aria-label="Octant"
        aria-selected={active}
        className={`composer-model-picker__rail-item composer-model-picker__rail-item--octant${active ? " composer-model-picker__rail-item--active" : ""}`}
        key={OCTANT_RAIL_ID}
        onClick={() => {
          setQuery("");
          setCatalogFilter(undefined);
          setActiveRailId(OCTANT_RAIL_ID);
        }}
        onMouseEnter={() => {
          if (searching) return;
          setCatalogFilter(undefined);
          setActiveRailId(OCTANT_RAIL_ID);
        }}
        role="option"
        title="Octant — native harness"
        type="button"
        variant="ghost"
      >
        <ProviderGlyph displayName="Octant" driverKind="octant-harness" size={16} />
        {worst === undefined ? null : (
          <span
            className="composer-model-picker__rail-status composer-model-picker__rail-status--degraded"
            title={worst}
          >
            <span className="sr-only">{worst}</span>
          </span>
        )}
      </OctantButton>
    );
  }

  return (
    <div className="composer-model-picker">
      <OctantPopover
        className="composer-model-picker__menu"
        onOpenChange={(next) => {
          if (next) setQuery("");
          setOpen(next);
        }}
        open={open}
        side={props.menuSide ?? "top"}
        sideOffset={8}
        title="Choose provider and model"
        trigger={
          <>
            <span className="composer-model-picker__trigger-label">{selectedLabel}</span>
            <ChevronDown aria-hidden="true" className="composer-model-picker__chevron" size={12} />
          </>
        }
        triggerClassName="composer-model-picker__trigger"
        triggerLabel={ariaLabel}
        {...(props.disabled === undefined ? {} : { triggerDisabled: props.disabled })}
      >
        <div aria-label="Providers" className="composer-model-picker__rail" role="listbox">
          <OctantButton
            aria-label="Favorites"
            aria-selected={favoritesActive}
            className={`composer-model-picker__rail-item composer-model-picker__rail-item--favorites${favoritesActive ? " composer-model-picker__rail-item--active" : ""}`}
            onClick={() => {
              setQuery("");
              setCatalogFilter(undefined);
              setActiveRailId(FAVORITES_RAIL_ID);
            }}
            role="option"
            title="Favorites"
            type="button"
            variant="ghost"
          >
            <Star aria-hidden="true" fill="currentColor" size={16} strokeWidth={1.75} />
          </OctantButton>
          <OctantSeparator aria-hidden="true" className="my-0.5 w-5 shrink-0" />
          {railGroups.flatMap((group, index) => {
            const entries = [];
            if (
              harnessGroups.length > 0 &&
              index === Math.min(octantRailIndex, railGroups.length)
            ) {
              entries.push(renderOctantRailItem());
            }
            entries.push(renderRailItem(group));
            return entries;
          })}
          {harnessGroups.length > 0 && octantRailIndex >= railGroups.length
            ? renderOctantRailItem()
            : null}
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
          {octantActive ? (
            <p className="composer-model-picker__runtime-note">
              Octant runs these endpoint models with its own tools, routing, and advisor.{" "}
              {props.onOpenHarnessSettings === undefined ? null : (
                <OctantButton
                  className="composer-model-picker__runtime-link"
                  onClick={props.onOpenHarnessSettings}
                  type="button"
                  variant="link"
                >
                  Model slots
                </OctantButton>
              )}
            </p>
          ) : null}
          {catalogs.length > 1 ? (
            <div aria-label="Catalogs" className="composer-model-picker__catalogs" role="group">
              <OctantButton
                aria-pressed={filteringCatalog === undefined}
                className={`composer-model-picker__catalog${filteringCatalog === undefined ? " composer-model-picker__catalog--on" : ""}`}
                onClick={() => setCatalogFilter(undefined)}
                type="button"
                variant="ghost"
              >
                All
              </OctantButton>
              {catalogs.map((catalog) => (
                <OctantButton
                  aria-pressed={filteringCatalog === catalog}
                  className={`composer-model-picker__catalog${filteringCatalog === catalog ? " composer-model-picker__catalog--on" : ""}`}
                  key={catalog}
                  onClick={() => setCatalogFilter(catalog)}
                  type="button"
                  variant="ghost"
                >
                  {catalog}
                </OctantButton>
              ))}
            </div>
          ) : null}
          <div aria-label="Models" className="composer-model-picker__models" role="listbox">
            {models.length === 0 ? (
              <p className="composer-model-picker__models-empty" role="status">
                {searching
                  ? "No models match the search."
                  : favoritesActive
                    ? "No favorites yet. Star a model to keep it here."
                    : filteringCatalog === undefined
                      ? "No models reported for this provider."
                      : `No ${filteringCatalog} models from this provider.`}
              </p>
            ) : (
              blocks.map((block) => {
                const rows = block.rows.map((row) =>
                  renderModelRow(row, block.catalog === undefined),
                );
                if (block.catalog === undefined) return rows;
                return (
                  <div
                    aria-label={block.catalog}
                    className="composer-model-picker__catalog-group"
                    key={block.catalog}
                    role="group"
                  >
                    <p className="composer-model-picker__catalog-heading">{block.catalog}</p>
                    {rows}
                  </div>
                );
              })
            )}
          </div>
        </div>
      </OctantPopover>
    </div>
  );
}

function matchesQuery(row: ModelRow, trimmedQuery: string): boolean {
  // The catalog counts as a match so "qwen" finds every Qwen-served model even
  // when the provider's display name for it never says Qwen.
  return (
    row.picker.model.displayName.toLowerCase().includes(trimmedQuery) ||
    (row.picker.catalog ?? "").toLowerCase().includes(trimmedQuery)
  );
}

function groupByCatalog(
  rows: ReadonlyArray<ModelRow>,
  catalogs: ReadonlyArray<string>,
): ReadonlyArray<{ readonly catalog: string | undefined; readonly rows: ReadonlyArray<ModelRow> }> {
  const blocks: Array<{ catalog: string | undefined; rows: ModelRow[] }> = [];
  // Models the provider left un-namespaced lead, unheaded: inventing a catalog
  // name for them would claim an origin the provider never reported.
  const loose = rows.filter((row) => row.picker.catalog === undefined);
  if (loose.length > 0) blocks.push({ catalog: undefined, rows: loose });
  for (const catalog of catalogs) {
    const matching = rows.filter((row) => row.picker.catalog === catalog);
    if (matching.length > 0) blocks.push({ catalog, rows: matching });
  }
  return blocks;
}

/** Under the Octant entry, models are headed by the endpoint that serves them. */
function groupByEndpoint(
  rows: ReadonlyArray<ModelRow>,
): ReadonlyArray<{ readonly catalog: string | undefined; readonly rows: ReadonlyArray<ModelRow> }> {
  const blocks: Array<{ catalog: string; rows: ModelRow[] }> = [];
  for (const row of rows) {
    const label = row.group.instance.displayName;
    const block = blocks.find((entry) => entry.catalog === label);
    if (block === undefined) blocks.push({ catalog: label, rows: [row] });
    else block.rows.push(row);
  }
  return blocks;
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
