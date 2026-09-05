import type { ProviderInstanceId, ProviderModelId } from "@octant/contracts";
import type {
  ModelBadge,
  ModelPickerSelection,
  PickerGroup,
  PickerModel,
  PickerSection,
} from "@octant/domain";
import { useMemo, useRef, useState, type KeyboardEvent } from "react";
import { filterModelPickerGroups } from "@octant/domain";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantInput } from "../ui/base/OctantInput";

export interface ModelPickerProps {
  readonly groups: ReadonlyArray<PickerGroup>;
  readonly selectedProviderInstanceId?: ProviderInstanceId | undefined;
  readonly selectedModelId?: ProviderModelId | undefined;
  readonly onSelect: (selection: ModelPickerSelection) => void;
  readonly searchPlaceholder?: string;
  readonly ariaLabel?: string;
  readonly disabled?: boolean;
  readonly narrow?: boolean;
}

interface FlatOption {
  readonly providerInstanceId: ProviderInstanceId;
  readonly modelId: ProviderModelId;
  readonly label: string;
  readonly picker: PickerModel;
  readonly sectionId: string;
}

export function ModelPicker(props: ModelPickerProps) {
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(-1);
  const listboxRef = useRef<HTMLDivElement>(null);

  const filtered = useMemo(
    () => filterModelPickerGroups(props.groups, query),
    [props.groups, query],
  );
  const flatOptions = useMemo(() => flattenOptions(filtered), [filtered]);
  const effectiveActive =
    activeIndex < 0 || flatOptions.length === 0
      ? -1
      : Math.min(activeIndex, flatOptions.length - 1);

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (props.disabled) return;
    if (flatOptions.length === 0) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex((current) => {
        const next = current + 1;
        return next >= flatOptions.length ? 0 : next;
      });
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((current) => {
        const next = current - 1;
        return next < 0 ? flatOptions.length - 1 : next;
      });
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      const option = flatOptions[effectiveActive];
      if (option !== undefined) {
        props.onSelect({ providerInstanceId: option.providerInstanceId, modelId: option.modelId });
      }
    }
  }

  const empty = filtered.length === 0;
  return (
    <div className={`model-picker${props.narrow === true ? " model-picker--narrow" : ""}`}>
      <OctantInput
        aria-label={props.ariaLabel ?? "Search providers and models"}
        className="model-picker__search window-no-drag"
        disabled={props.disabled}
        onChange={(event) => {
          setQuery(event.currentTarget.value);
          setActiveIndex(-1);
        }}
        placeholder={props.searchPlaceholder ?? "Search providers and models"}
        role="searchbox"
        type="search"
        value={query}
      />
      {empty ? (
        <p className="model-picker__empty" role="status">
          {props.groups.length === 0
            ? "No providers available. Configure and probe a provider in Settings."
            : "No providers or models match your search."}
        </p>
      ) : (
        <div
          aria-label={props.ariaLabel ?? "Model picker"}
          className={`model-picker__listbox${props.narrow === true ? " model-picker--narrow" : ""}`}
          onKeyDown={handleKeyDown}
          ref={listboxRef}
          role="listbox"
          tabIndex={props.disabled ? -1 : 0}
        >
          {umbrellaBlocks(filtered).map((block) =>
            block.kind === "octant" ? (
              <div className="model-picker__group model-picker__group--octant" key="octant-harness">
                <div className="model-picker__group-header">
                  <span className="model-picker__group-name">Octant</span>
                  <span className="model-picker__group-meta">
                    <span className="model-picker__group-driver">Native harness</span>
                  </span>
                </div>
                {block.groups.map((group) => (
                  <ProviderGroupView
                    group={group}
                    key={String(group.instance.id)}
                    nested
                    selectedProviderInstanceId={props.selectedProviderInstanceId}
                    selectedModelId={props.selectedModelId}
                    activeProviderInstanceId={
                      effectiveActive >= 0
                        ? flatOptions[effectiveActive]?.providerInstanceId
                        : undefined
                    }
                    activeModelId={
                      effectiveActive >= 0 ? flatOptions[effectiveActive]?.modelId : undefined
                    }
                    disabled={props.disabled === true}
                    onSelect={props.onSelect}
                  />
                ))}
              </div>
            ) : (
              <ProviderGroupView
                group={block.group}
                key={String(block.group.instance.id)}
                selectedProviderInstanceId={props.selectedProviderInstanceId}
                selectedModelId={props.selectedModelId}
                activeProviderInstanceId={
                  effectiveActive >= 0
                    ? flatOptions[effectiveActive]?.providerInstanceId
                    : undefined
                }
                activeModelId={
                  effectiveActive >= 0 ? flatOptions[effectiveActive]?.modelId : undefined
                }
                disabled={props.disabled === true}
                onSelect={props.onSelect}
              />
            ),
          )}
        </div>
      )}
    </div>
  );
}

type UmbrellaBlock =
  | { readonly kind: "provider"; readonly group: PickerGroup }
  | { readonly kind: "octant"; readonly groups: ReadonlyArray<PickerGroup> };

/**
 * Endpoints the native harness drives are shown together under one Octant
 * heading, placed where the first of them sat in the provider order.
 */
function umbrellaBlocks(groups: ReadonlyArray<PickerGroup>): ReadonlyArray<UmbrellaBlock> {
  const blocks: UmbrellaBlock[] = [];
  const harness = groups.filter((group) => group.runtime === "octant-harness");
  let placed = false;
  for (const group of groups) {
    if (group.runtime === "octant-harness") {
      if (!placed) {
        blocks.push({ kind: "octant", groups: harness });
        placed = true;
      }
      continue;
    }
    blocks.push({ kind: "provider", group });
  }
  return blocks;
}

function ProviderGroupView(props: {
  readonly group: PickerGroup;
  readonly nested?: boolean;
  readonly selectedProviderInstanceId?: ProviderInstanceId | undefined;
  readonly selectedModelId?: ProviderModelId | undefined;
  readonly activeProviderInstanceId?: ProviderInstanceId | undefined;
  readonly activeModelId?: ProviderModelId | undefined;
  readonly disabled: boolean;
  readonly onSelect: (selection: ModelPickerSelection) => void;
}) {
  const { group } = props;
  return (
    <div
      className={`model-picker__group${props.nested === true ? " model-picker__group--nested" : ""}`}
    >
      <div className="model-picker__group-header">
        <span className="model-picker__group-name">{group.instance.displayName}</span>
        <span className="model-picker__group-meta">
          <span className="model-picker__group-driver">{group.driverLabel}</span>
          {group.endpointHost !== undefined ? (
            <span className="model-picker__group-host">{group.endpointHost}</span>
          ) : null}
          <span className="model-picker__group-execution">{group.executionHost}</span>
        </span>
        <span className={`model-picker__readiness model-picker__readiness--${group.readiness}`}>
          {readinessLabel(group.readiness)}
        </span>
      </div>
      {group.unavailableCurrent !== undefined ? (
        <UnavailableCurrentView picker={group.unavailableCurrent} instanceId={group.instance.id} />
      ) : null}
      {group.sections.map((section) => (
        <SectionView
          key={section.id}
          section={section}
          providerInstanceId={group.instance.id}
          selectedModelId={
            props.selectedProviderInstanceId === group.instance.id
              ? props.selectedModelId
              : undefined
          }
          activeModelId={
            props.activeProviderInstanceId === group.instance.id ? props.activeModelId : undefined
          }
          disabled={props.disabled}
          onSelect={props.onSelect}
        />
      ))}
    </div>
  );
}

function SectionView(props: {
  readonly section: PickerSection;
  readonly providerInstanceId: ProviderInstanceId;
  readonly selectedModelId?: ProviderModelId | undefined;
  readonly activeModelId?: ProviderModelId | undefined;
  readonly disabled: boolean;
  readonly onSelect: (selection: ModelPickerSelection) => void;
}) {
  if (props.section.models.length === 0) return null;
  const shared = sharedBadgeKinds(props.section.models);
  return (
    <div className="model-picker__section" role="group" aria-label={props.section.label}>
      <span className="model-picker__section-label">{props.section.label}</span>
      <ul className="model-picker__options">
        {props.section.models.map((picker) => {
          const modelId = picker.model.id;
          const capabilities = picker.badges.filter((badge) => !shared.has(badge.kind));
          const unavailable = picker.unavailableReason !== undefined;
          const selected =
            props.selectedModelId !== undefined &&
            String(props.selectedModelId) === String(modelId);
          const active =
            props.activeModelId !== undefined && String(props.activeModelId) === String(modelId);
          return (
            <li key={String(modelId)}>
              <OctantButton
                aria-disabled={unavailable}
                aria-selected={selected}
                className={`model-picker__option${active ? " model-picker__option--active" : ""}`}
                disabled={props.disabled || unavailable}
                onClick={() =>
                  props.onSelect({ providerInstanceId: props.providerInstanceId, modelId })
                }
                role="option"
                type="button"
              >
                <span className="model-picker__option-name">{picker.model.displayName}</span>
                <span className="model-picker__option-id">{String(modelId)}</span>
                {capabilities.length > 0 ? (
                  <span className="model-picker__capabilities">
                    {capabilities.map((badge) => badge.label).join(" · ")}
                  </span>
                ) : null}
                {picker.unavailableReason !== undefined ? (
                  <span className="model-picker__option-reason">{picker.unavailableReason}</span>
                ) : null}
              </OctantButton>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function UnavailableCurrentView(props: {
  readonly picker: PickerModel;
  readonly instanceId: ProviderInstanceId;
}) {
  return (
    <p className="model-picker__unavailable-current" role="status">
      <span className="model-picker__option-name">{props.picker.model.displayName}</span>
      <span className="model-picker__option-reason">{props.picker.unavailableReason}</span>
    </p>
  );
}

function readinessLabel(readiness: PickerGroup["readiness"]): string {
  switch (readiness) {
    case "ready":
      return "Ready";
    case "degraded":
      return "Degraded";
    case "unavailable":
      return "Unavailable";
    case "unauthenticated":
      return "Needs sign-in";
    case "incompatible":
      return "Incompatible";
    case "checking":
      return "Checking";
  }
}

/** A capability every model in the section carries says nothing about the
 * choice between them, so the rows print only the ones that differ. A
 * section of one model has nothing to differ from and keeps all of them. */
function sharedBadgeKinds(models: ReadonlyArray<PickerModel>): ReadonlySet<ModelBadge["kind"]> {
  if (models.length < 2) return new Set();
  const [first, ...rest] = models;
  if (first === undefined) return new Set();
  const shared = new Set(first.badges.map((badge) => badge.kind));
  for (const model of rest) {
    const kinds = new Set(model.badges.map((badge) => badge.kind));
    for (const kind of shared) {
      if (!kinds.has(kind)) shared.delete(kind);
    }
  }
  return shared;
}

function flattenOptions(groups: ReadonlyArray<PickerGroup>): ReadonlyArray<FlatOption> {
  const options: FlatOption[] = [];
  for (const group of groups) {
    for (const section of group.sections) {
      for (const picker of section.models) {
        if (picker.unavailableReason !== undefined) continue;
        options.push({
          providerInstanceId: group.instance.id,
          modelId: picker.model.id,
          label: picker.model.displayName,
          picker,
          sectionId: section.id,
        });
      }
    }
  }
  return options;
}
