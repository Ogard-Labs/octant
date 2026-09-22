import type {
  ProviderInstanceId,
  ProviderModelId,
  ProviderModelOptionValues,
} from "@octant/contracts";
import type { ModelPickerSelection, PickerGroup, PickerModel } from "@octant/domain";
import { findPickerModel, pickerCatalogs } from "@octant/domain";
import { ChevronDown, Clock, Plus, RotateCcw, Search, Star } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
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
import { OctantSlider } from "../ui/base/OctantSlider";
import { rememberModelChoice } from "./modelChoiceMemory";
import { readRecentModels, rememberModel } from "./modelRecents";
import { ProviderGlyph } from "./ProviderGlyph";

/**
 * One selectable option the selected model declares (effort, reasoning, speed
 * tier). `value` is the thread's current choice; absent means provider default.
 */
export interface ComposerModelPickerModelOption {
  readonly id: string;
  readonly displayName: string;
  readonly values: ReadonlyArray<string>;
  readonly value?: string;
}

/**
 * Whether an option names how hard the model should think. The picker keeps
 * that one next to the model name; every other declared option stays in the
 * composer's options surface.
 */
export function isComposerReasoningOption(option: {
  readonly id: string;
  readonly displayName: string;
}): boolean {
  return /(reasoning|effort|thinking|thought)/i.test(`${option.id} ${option.displayName}`);
}

/** Sentinel meaning “use the provider default” rather than a declared value. */
const DEFAULT_LEVEL_ID = "__default__";

export interface ComposerModelPickerProps {
  readonly rememberChoice?: boolean;
  readonly groups: ReadonlyArray<PickerGroup>;
  readonly selectedProviderInstanceId?: ProviderInstanceId | undefined;
  readonly selectedModelId?: ProviderModelId | undefined;
  readonly unselectedLabel?: string;
  readonly onSelect: (selection: ModelPickerSelection) => void;
  readonly onOpenSettings?: () => void;
  /** Opens Settings → Octant Harness, shown from the Octant entry. */
  readonly onOpenHarnessSettings?: () => void;
  readonly disabled?: boolean;
  readonly ariaLabel?: string;
  /**
   * The selected model's declared options. A reasoning/effort option among
   * them is drawn inline in the picker so choosing a model and choosing how
   * hard it thinks are one decision.
   */
  readonly modelOptions?: ReadonlyArray<ComposerModelPickerModelOption>;
  readonly modelOptionValues?: ProviderModelOptionValues;
  /** Absent leaves the inline level control out; undefined restores the default. */
  readonly onModelOptionChange?: (optionId: string, value: string | undefined) => void;
  /**
   * Which side of the trigger the menu opens on. Most composers sit at the
   * bottom of their view, so the menu opens upward by default; a composer
   * that sits mid-screen (Work/Code composer bars, the Chat welcome and
   * Project quick-start forms) passes "bottom" so it opens downward instead.
   */
  readonly menuSide?: "top" | "bottom";
}

const FAVORITES_RAIL_ID = "favorites";
const RECENT_RAIL_ID = "recent";
/** One rail entry for every endpoint the native harness drives. */
const OCTANT_RAIL_ID = "octant-harness";
type RailId =
  | ProviderInstanceId
  | typeof FAVORITES_RAIL_ID
  | typeof RECENT_RAIL_ID
  | typeof OCTANT_RAIL_ID;

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
  const modelsElement = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState("");
  const [catalogFilter, setCatalogFilter] = useState<string | undefined>(undefined);
  const [favorites, setFavorites] = useState<ReadonlySet<string>>(() => readModelFavorites());
  const [recentModels, setRecentModels] = useState<ReadonlyArray<string>>(() => readRecentModels());
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
    // Provider discovery is live and can replace the groups array while the
    // menu is open. Keep the rail the user chose as long as that entry still
    // exists; resetting to the selected model on every refresh made the pane
    // appear to bounce between providers under the pointer. Reconcile only
    // when the active entry was actually removed.
    setActiveRailId((current) => {
      const stillAvailable =
        current === FAVORITES_RAIL_ID ||
        current === RECENT_RAIL_ID ||
        (current === OCTANT_RAIL_ID && harnessGroups.length > 0) ||
        (current !== undefined && props.groups.some((group) => group.instance.id === current));
      return stillAvailable ? current : (railIdFor(selectedGroup) ?? railIdFor(props.groups[0]));
    });
  }, [open, props.groups, selectedGroup, harnessGroups.length]);

  if (props.groups.length === 0) {
    return (
      <div className="composer-model-picker composer-model-picker--empty">
        <OctantButton
          aria-label={ariaLabel}
          className="composer-model-picker__trigger window-no-drag"
          disabled={props.disabled || props.onOpenSettings === undefined}
          onClick={props.onOpenSettings}
          size="sm"
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
    (props.selectedModelId === undefined ? undefined : String(props.selectedModelId)) ??
    props.unselectedLabel ??
    selectedGroup?.sections[0]?.models[0]?.model.displayName ??
    selectedGroup?.instance.displayName ??
    "Choose model";
  // The inline level control shows only when the caller owns the option value
  // and the selected model actually declares a reasoning/effort option.
  const declaredOptions =
    findPickerModel(
      props.groups,
      props.selectedProviderInstanceId === undefined || props.selectedModelId === undefined
        ? undefined
        : {
            providerInstanceId: props.selectedProviderInstanceId,
            modelId: props.selectedModelId,
          },
    )?.model.options ?? [];
  const modelOptions =
    props.modelOptions ??
    declaredOptions.flatMap((option) =>
      option.kind === "selection"
        ? [
            {
              id: option.id,
              displayName: option.displayName,
              values: option.values,
              ...(props.modelOptionValues?.[option.id] === undefined
                ? {}
                : { value: props.modelOptionValues[option.id] }),
            },
          ]
        : [],
    );
  const levelOption = modelOptions.find(isComposerReasoningOption);
  const levelValue =
    levelOption !== undefined &&
    levelOption.value !== undefined &&
    levelOption.values.includes(levelOption.value)
      ? levelOption.value
      : DEFAULT_LEVEL_ID;
  // Stop 0 is the provider default; stop i is values[i - 1], so the knob
  // never has to point at a value the model does not declare.
  const levelIndex =
    levelOption === undefined || levelValue === DEFAULT_LEVEL_ID
      ? 0
      : levelOption.values.indexOf(levelValue) + 1;
  const recentActive = !searching && activeRailId === RECENT_RAIL_ID;
  const favoritesActive = !searching && activeRailId === FAVORITES_RAIL_ID;
  // With a search query, matches span every provider; the Favorites rail entry
  // lists starred models across providers; otherwise the list shows the active
  // provider's models.
  const allModels: ReadonlyArray<ModelRow> = searching
    ? props.groups.flatMap((group) =>
        flattenModels(group).filter((row) => matchesQuery(row, trimmedQuery)),
      )
    : recentActive
      ? props.groups
          .flatMap((group) => flattenModels(group))
          .filter((row) =>
            recentModels.includes(modelFavoriteKey(row.group.instance.id, row.picker.model.id)),
          )
          .sort(
            (a, b) =>
              recentModels.indexOf(modelFavoriteKey(a.group.instance.id, a.picker.model.id)) -
              recentModels.indexOf(modelFavoriteKey(b.group.instance.id, b.picker.model.id)),
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
  const catalogs =
    searching || favoritesActive || recentActive || octantActive ? [] : pickerCatalogs(activeGroup);
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
      searching || favoritesActive || recentActive ? group.instance.displayName : undefined,
      showCatalog ? picker.catalog : undefined,
      sectionId === "all-models" ||
      sectionId === "tool-capable" ||
      sectionLabel === group.instance.displayName
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
          aria-description={detail === "" ? undefined : detail}
          aria-selected={selected}
          className={`composer-model-picker__model${selected ? " composer-model-picker__model--selected" : ""}${unavailable ? " composer-model-picker__model--unavailable" : ""}`}
          disabled={unavailable || props.disabled}
          onClick={() => {
            if (unavailable) return;
            rememberModel(group.instance.id, modelId);
            if (props.rememberChoice !== false)
              rememberModelChoice({ providerInstanceId: group.instance.id, modelId });
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
            {detail === "" ? null : (
              <span className="composer-model-picker__model-detail">
                <ProviderGlyph
                  displayName={group.instance.displayName}
                  driverKind={group.instance.driverKind}
                  size={12}
                />
                {detail}
              </span>
            )}
          </span>
          {unavailable ? (
            <OctantBadge className="composer-model-picker__model-badge" variant="secondary">
              {compactUnavailableLabel(picker.unavailableReason)}
            </OctantBadge>
          ) : null}
        </OctantButton>
        <OctantButton
          aria-label={`${favorited ? "Remove" : "Add"} ${picker.model.displayName} (${group.instance.displayName}) ${favorited ? "from" : "to"} favorites`}
          aria-pressed={favorited}
          className={`composer-model-picker__star${favorited ? " composer-model-picker__star--on" : ""}`}
          onClick={(event) => {
            event.stopPropagation();
            toggleFavorite(favoriteKey);
          }}
          title={`${favorited ? "Remove" : "Add"} ${picker.model.displayName} (${group.instance.displayName}) ${favorited ? "from" : "to"} favorites`}
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
        role="option"
        title={group.instance.displayName}
        type="button"
        variant="ghost"
      >
        <ProviderGlyph
          displayName={group.instance.displayName}
          driverKind={group.instance.driverKind}
          size={20}
        />
        <span className="composer-model-picker__rail-label">{group.instance.displayName}</span>
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
        role="option"
        title="Octant — native harness"
        type="button"
        variant="ghost"
      >
        <ProviderGlyph displayName="Octant" driverKind="octant-harness" size={20} />
        <span className="composer-model-picker__rail-label">Octant</span>
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
        align="end"
        className="composer-model-picker__menu"
        collisionAvoidance={{ side: "flip", align: "shift", fallbackAxisSide: "none" }}
        onOpenChange={(next) => {
          if (next) {
            setQuery("");
            setCatalogFilter(undefined);
            setFavorites(readModelFavorites());
            setRecentModels(readRecentModels());
            setActiveRailId(railIdFor(selectedGroup) ?? railIdFor(props.groups[0]));
          }
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
        triggerVariant="ghost"
        {...(props.disabled === undefined ? {} : { triggerDisabled: props.disabled })}
      >
        <div
          aria-label="Providers"
          aria-orientation="horizontal"
          className="composer-model-picker__rail"
          role="listbox"
        >
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
            <Star aria-hidden="true" fill="currentColor" size={20} strokeWidth={1.75} />
            <span className="composer-model-picker__rail-label">Favorites</span>
          </OctantButton>
          <OctantButton
            aria-label="Recent"
            aria-selected={recentActive}
            className={`composer-model-picker__rail-item${recentActive ? " composer-model-picker__rail-item--active" : ""}`}
            onClick={() => {
              setQuery("");
              setCatalogFilter(undefined);
              setActiveRailId(RECENT_RAIL_ID);
            }}
            role="option"
            title="Recent"
            type="button"
            variant="ghost"
          >
            <Clock aria-hidden="true" size={20} />
            <span className="composer-model-picker__rail-label">Recent</span>
          </OctantButton>
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
          {props.onOpenSettings === undefined ? null : (
            <OctantButton
              aria-label="Provider settings"
              title="Provider settings"
              className="composer-model-picker__rail-item"
              onClick={props.onOpenSettings}
              variant="ghost"
              type="button"
            >
              <Plus aria-hidden="true" size={20} />
            </OctantButton>
          )}
        </div>
        <div className="composer-model-picker__pane">
          <label className="composer-model-picker__search">
            <Search aria-hidden="true" size={14} />
            <OctantInput
              autoFocus
              aria-label="Search models"
              onKeyDown={(event) => {
                if (event.key !== "ArrowDown") return;
                event.preventDefault();
                modelsElement.current
                  ?.querySelector<HTMLButtonElement>('[role="option"]:not(:disabled)')
                  ?.focus();
              }}
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
            <div
              aria-label="Catalogs"
              className="composer-model-picker__catalogs"
              // A fresh row per provider: a reused one kept the sideways
              // offset of the provider before it, so this one's All chip
              // opened out of view.
              key={String(activeRailId)}
              role="group"
            >
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
          <div
            aria-label="Models"
            className="composer-model-picker__models"
            role="listbox"
            ref={modelsElement}
            onKeyDown={(event) => {
              if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
              const options = Array.from(
                event.currentTarget.querySelectorAll<HTMLButtonElement>(
                  '[role="option"]:not(:disabled)',
                ),
              );
              const current = options.findIndex((option) => option === event.target);
              if (current < 0) return;
              event.preventDefault();
              const next =
                event.key === "Home"
                  ? 0
                  : event.key === "End"
                    ? options.length - 1
                    : Math.max(
                        0,
                        Math.min(
                          options.length - 1,
                          current + (event.key === "ArrowDown" ? 1 : -1),
                        ),
                      );
              options[next]?.focus();
            }}
          >
            {models.length === 0 ? (
              <p className="composer-model-picker__models-empty" role="status">
                {searching
                  ? "No models match the search."
                  : recentActive
                    ? "Models you choose appear here."
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
        <p className="sr-only">↓ Browse · Enter select · Esc close</p>
        {levelOption === undefined || props.onModelOptionChange === undefined ? null : (
          <LevelSlider
            displayName={levelOption.displayName}
            disabled={props.disabled === true}
            labels={["Default", ...levelOption.values.map(levelLabel)]}
            onIndexChange={(index) => {
              const value = index === 0 ? undefined : levelOption.values[index - 1];
              if (
                props.rememberChoice !== false &&
                props.selectedProviderInstanceId !== undefined &&
                props.selectedModelId !== undefined
              ) {
                rememberModelChoice(
                  {
                    providerInstanceId: props.selectedProviderInstanceId,
                    modelId: props.selectedModelId,
                  },
                  { id: levelOption.id, value },
                );
              }
              props.onModelOptionChange?.(levelOption.id, value);
            }}
            index={levelIndex}
          />
        )}
      </OctantPopover>
    </div>
  );
}

/**
 * “medium” reads as “Medium” beside the model the control belongs to. A
 * provider's “xhigh” capitalised as “Xhigh”, which reads as a typo, so it is
 * spelled out.
 */
function levelLabel(value: string): string {
  if (value === "xhigh") return "Extra high";
  return value.length === 0 ? value : `${value[0]?.toUpperCase() ?? ""}${value.slice(1)}`;
}

/**
 * The reasoning/effort choice as a discrete slider: the model's declared
 * levels are the stops, the provider default is the first one, and the knob
 * snaps to a stop. A row of segments needed a tap per level and overflowed
 * the menu past six of them; the slider keeps every level in the same width
 * and lets the reader hear which stop the knob sits on.
 */
function LevelSlider(props: {
  readonly displayName: string;
  readonly disabled: boolean;
  readonly labels: ReadonlyArray<string>;
  readonly index: number;
  readonly onIndexChange: (index: number) => void;
}) {
  const [dragIndex, setDragIndex] = useState<number | undefined>();
  const index = dragIndex ?? props.index;
  const label = props.labels[index] ?? "Default";
  const stopCount = props.labels.length;
  return (
    <div className="composer-model-picker__level">
      <div className="composer-model-picker__level-reading">
        <span className="composer-model-picker__level-label">{props.displayName}</span>
        <strong className="composer-model-picker__level-value">{label}</strong>
        <OctantButton
          aria-label="Reset reasoning to provider default"
          title="Reset reasoning to provider default"
          disabled={props.disabled || index === 0}
          onClick={() => props.onIndexChange(0)}
          size="icon"
          variant="ghost"
          type="button"
        >
          <RotateCcw aria-hidden="true" size={14} />
        </OctantButton>
      </div>
      <div className="composer-model-picker__level-control">
        <div aria-hidden="true" className="composer-model-picker__level-track">
          <span
            className="composer-model-picker__level-fill"
            style={{ width: `${stopCount <= 1 ? 0 : (index / (stopCount - 1)) * 100}%` }}
          />
          <span className="composer-model-picker__level-stops">
            {props.labels.map((stop, position) => (
              <span key={`${position}:${stop}`} title={stop} />
            ))}
          </span>
        </div>
        <OctantSlider
          className="composer-model-picker__reasoning-slider"
          aria-label={`${props.displayName} level`}
          aria-valuemax={stopCount - 1}
          aria-valuemin={0}
          aria-valuenow={index}
          aria-valuetext={label}
          disabled={props.disabled}
          min={0}
          max={stopCount - 1}
          step={1}
          value={index}
          onPointerDown={(event) => {
            event.currentTarget.setPointerCapture?.(event.pointerId);
            setDragIndex(props.index);
          }}
          onLostPointerCapture={() => setDragIndex(undefined)}
          onPointerCancel={() => setDragIndex(undefined)}
          onPointerUp={(event) => {
            const next = event.currentTarget.valueAsNumber;
            setDragIndex(undefined);
            props.onIndexChange(next);
          }}
          onChange={(event) => {
            const next = event.currentTarget.valueAsNumber;
            // Existing threads persist through versioned commands. Preview the
            // drag locally and send its final value once, rather than racing a
            // command for every intermediate stop against the same version.
            if (dragIndex !== undefined) setDragIndex(next);
            else props.onIndexChange(next);
          }}
        />
      </div>
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
  return group.hiddenCurrent?.model.displayName ?? group.unavailableCurrent?.model.displayName;
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
