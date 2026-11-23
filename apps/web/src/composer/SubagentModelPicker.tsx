import type { ProviderModel } from "@octant/contracts";
import { subagentReasoningValues, type PickerGroup, type SubagentModelTag } from "@octant/domain";
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { hasProviderLogo, ProviderGlyph } from "../providers/ProviderGlyph";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantInput } from "../ui/base/OctantInput";
import "./subagent-model.css";

/** One provider instance serving one model, as a subagent route the person can tag. */
export interface SubagentModelRoute {
  readonly group: PickerGroup;
  readonly model: ProviderModel;
  readonly reasoningValues: ReadonlyArray<string>;
}

function usable(group: PickerGroup): boolean {
  return group.readiness === "ready" || group.readiness === "degraded";
}

/**
 * Every model a configured, usable provider serves that can carry Octant's
 * tools, the rule the host applies to a subagent's target. A model two
 * providers serve is two routes, so the person chooses the provider as well
 * as the model. The launch still checks each route against the host's own
 * list, which can refuse more (a Project's policy, a sign-in that runs no
 * helpers).
 */
export function subagentModelRoutes(
  groups: ReadonlyArray<PickerGroup>,
): ReadonlyArray<SubagentModelRoute> {
  const routes: Array<SubagentModelRoute> = [];
  for (const group of groups) {
    if (!usable(group)) continue;
    const seen = new Set<string>();
    for (const section of group.sections) {
      for (const picker of section.models) {
        const id = String(picker.model.id);
        if (picker.unavailableReason !== undefined || !picker.toolCapable || seen.has(id)) {
          continue;
        }
        seen.add(id);
        routes.push({
          group,
          model: picker.model,
          reasoningValues: subagentReasoningValues(picker.model),
        });
      }
    }
  }
  return routes;
}

export type SubagentModelTagResolution =
  | { readonly status: "available"; readonly route: SubagentModelRoute }
  | {
      readonly status: "unavailable";
      readonly reason: string;
      readonly group?: PickerGroup;
      readonly model?: ProviderModel;
    };

/** Whether a tag still names a route the person can use, and if not, which choice needs attention. */
export function resolveSubagentModelTag(
  groups: ReadonlyArray<PickerGroup>,
  tag: SubagentModelTag,
): SubagentModelTagResolution {
  const group = groups.find(
    (candidate) => String(candidate.instance.id) === tag.providerInstanceId,
  );
  if (group === undefined) {
    return { status: "unavailable", reason: "This provider is no longer configured." };
  }
  if (!usable(group)) {
    return {
      status: "unavailable",
      reason: group.readinessReason ?? `${group.instance.displayName} is not ready.`,
      group,
    };
  }
  const route = subagentModelRoutes([group]).find(
    (candidate) => String(candidate.model.id) === tag.modelId,
  );
  if (route === undefined) {
    const listed = group.sections
      .flatMap((section) => section.models)
      .find((picker) => String(picker.model.id) === tag.modelId);
    return {
      status: "unavailable",
      reason:
        listed === undefined
          ? `${group.instance.displayName} no longer offers this model.`
          : `${listed.model.displayName} cannot run Octant's tools, so it cannot take a subagent.`,
      group,
      ...(listed === undefined ? {} : { model: listed.model }),
    };
  }
  if (tag.reasoning !== undefined && !route.reasoningValues.includes(tag.reasoning)) {
    return {
      status: "unavailable",
      reason: `${route.model.displayName} does not offer reasoning “${tag.reasoning}”.`,
      group,
      model: route.model,
    };
  }
  return { status: "available", route };
}

const PROVIDER_DEFAULT = "Provider default";

/**
 * The chip a `@model(...)` tag shows in the prompt: provider logo – model –
 * reasoning. The provider's name is its accessible name and its tooltip, and
 * stands in for the logo when the provider has none. Activating it reopens the
 * picker on its current values.
 */
export function SubagentModelChip(props: {
  readonly groups: ReadonlyArray<PickerGroup>;
  readonly tag: SubagentModelTag;
  readonly onActivate: () => void;
}) {
  const resolved = resolveSubagentModelTag(props.groups, props.tag);
  const group = resolved.status === "available" ? resolved.route.group : resolved.group;
  const model = resolved.status === "available" ? resolved.route.model : resolved.model;
  const providerName = group?.instance.displayName ?? "Unknown provider";
  const modelName = model?.displayName ?? props.tag.modelId;
  const reasoning = props.tag.reasoning ?? PROVIDER_DEFAULT;
  const problem = resolved.status === "unavailable" ? resolved.reason : undefined;
  return (
    <OctantButton
      aria-label={`Subagent model: ${providerName}, ${modelName}, ${reasoning}${
        problem === undefined ? "" : `. Needs attention: ${problem}`
      }`}
      className="composer-chip__button"
      data-unavailable={problem === undefined ? undefined : "true"}
      onClick={props.onActivate}
      onMouseDown={(event) => event.preventDefault()}
      title={problem === undefined ? providerName : `${providerName}: ${problem}`}
      type="button"
      variant="bare"
    >
      {group !== undefined && hasProviderLogo(group.instance.driverKind) ? (
        <ProviderGlyph
          displayName={providerName}
          driverKind={group.instance.driverKind}
          size={14}
        />
      ) : (
        <span className="composer-chip__text">{providerName}</span>
      )}
      <span aria-hidden="true" className="composer-chip__meta">
        –
      </span>
      <span className="composer-chip__text">{modelName}</span>
      <span aria-hidden="true" className="composer-chip__meta">
        –
      </span>
      <span className="composer-chip__meta">{reasoning}</span>
    </OctantButton>
  );
}

function matches(route: SubagentModelRoute, query: string): boolean {
  if (query === "") return true;
  const needle = query.toLowerCase();
  return [route.model.displayName, String(route.model.id), route.group.instance.displayName].some(
    (text) => text.toLowerCase().includes(needle),
  );
}

/**
 * The searchable `@model` picker: choose a provider's model, then one of the
 * reasoning values that route advertises (or the provider's default). Enter
 * inserts the tag; Escape dismisses and leaves the draft as it was.
 */
export function SubagentModelPicker(props: {
  readonly groups: ReadonlyArray<PickerGroup>;
  readonly initial?: SubagentModelTag | undefined;
  readonly onChoose: (tag: SubagentModelTag) => void;
  readonly onDismiss: () => void;
}) {
  const listId = useId();
  const searchRef = useRef<HTMLInputElement>(null);
  const routes = useMemo(() => subagentModelRoutes(props.groups), [props.groups]);
  const [query, setQuery] = useState("");
  const [chosen, setChosen] = useState<SubagentModelRoute | undefined>(undefined);
  const visible = routes.filter((route) => matches(route, query));
  const initialIndex =
    props.initial === undefined
      ? 0
      : Math.max(
          0,
          visible.findIndex(
            (route) =>
              String(route.group.instance.id) === props.initial?.providerInstanceId &&
              String(route.model.id) === props.initial.modelId,
          ),
        );
  const [activeIndex, setActiveIndex] = useState(initialIndex);
  useEffect(() => {
    searchRef.current?.focus();
  }, [chosen]);

  const reasoningRows: ReadonlyArray<string | undefined> =
    chosen === undefined ? [] : [undefined, ...chosen.reasoningValues];
  const rowCount = chosen === undefined ? visible.length : reasoningRows.length;
  const active = rowCount === 0 ? 0 : Math.min(activeIndex, rowCount - 1);

  const finish = (route: SubagentModelRoute, reasoning: string | undefined) => {
    props.onChoose({
      providerInstanceId: String(route.group.instance.id),
      modelId: String(route.model.id),
      ...(reasoning === undefined ? {} : { reasoning }),
    });
  };
  const pickRoute = (route: SubagentModelRoute) => {
    if (route.reasoningValues.length === 0) {
      finish(route, undefined);
      return;
    }
    const sameRoute =
      props.initial !== undefined &&
      props.initial.providerInstanceId === String(route.group.instance.id) &&
      props.initial.modelId === String(route.model.id);
    const current = sameRoute ? props.initial?.reasoning : undefined;
    setChosen(route);
    setQuery("");
    setActiveIndex(current === undefined ? 0 : route.reasoningValues.indexOf(current) + 1);
  };
  const pickActive = () => {
    if (chosen === undefined) {
      const route = visible[active];
      if (route !== undefined) pickRoute(route);
      return;
    }
    if (active < reasoningRows.length) finish(chosen, reasoningRows[active]);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return;
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        if (rowCount > 0) setActiveIndex((active + 1) % rowCount);
        return;
      case "ArrowUp":
        event.preventDefault();
        if (rowCount > 0) setActiveIndex((active - 1 + rowCount) % rowCount);
        return;
      case "Enter":
        event.preventDefault();
        pickActive();
        return;
      case "Escape":
        event.preventDefault();
        event.stopPropagation();
        props.onDismiss();
        return;
      default:
    }
  };
  const optionId = (index: number) => `${listId}-${index}`;

  return (
    <div
      aria-label={
        chosen === undefined
          ? "Choose a subagent model"
          : `Reasoning for ${chosen.model.displayName}`
      }
      className="chat-composer__command-typeahead subagent-model-picker"
      role="group"
    >
      <OctantInput
        aria-activedescendant={rowCount === 0 ? undefined : optionId(active)}
        aria-autocomplete="list"
        aria-controls={listId}
        aria-expanded="true"
        aria-label={chosen === undefined ? "Search models" : "Choose reasoning"}
        className="subagent-model-picker__search"
        readOnly={chosen !== undefined}
        onBlur={(event) => {
          if (
            !event.currentTarget.closest(".subagent-model-picker")?.contains(event.relatedTarget)
          ) {
            props.onDismiss();
          }
        }}
        onChange={(event) => {
          setQuery(event.target.value);
          setActiveIndex(0);
        }}
        onKeyDown={onKeyDown}
        placeholder={chosen === undefined ? "Search models" : chosen.model.displayName}
        ref={searchRef}
        role="combobox"
        unstyled
        value={query}
      />
      <ul
        aria-label={chosen === undefined ? "Subagent models" : "Reasoning"}
        className="chat-composer__command-list"
        id={listId}
        role="listbox"
      >
        {chosen === undefined
          ? visible.map((route, index) => (
              <li
                className="chat-composer__command-option"
                key={`${String(route.group.instance.id)}/${String(route.model.id)}`}
                role="presentation"
              >
                <OctantButton
                  aria-selected={index === active}
                  id={optionId(index)}
                  onClick={() => pickRoute(route)}
                  onMouseDown={(event) => event.preventDefault()}
                  onMouseEnter={() => setActiveIndex(index)}
                  role="option"
                  size="sm"
                  type="button"
                  variant={index === active ? "secondary" : "ghost"}
                >
                  <ProviderGlyph
                    displayName={route.group.instance.displayName}
                    driverKind={route.group.instance.driverKind}
                    size={12}
                  />
                  <span>{route.model.displayName}</span>
                  <span className="chat-composer__command-meta">
                    {route.group.instance.displayName}
                  </span>
                </OctantButton>
              </li>
            ))
          : reasoningRows.map((value, index) => (
              <li
                className="chat-composer__command-option"
                key={value ?? PROVIDER_DEFAULT}
                role="presentation"
              >
                <OctantButton
                  aria-selected={index === active}
                  id={optionId(index)}
                  onClick={() => finish(chosen, value)}
                  onMouseDown={(event) => event.preventDefault()}
                  onMouseEnter={() => setActiveIndex(index)}
                  role="option"
                  size="sm"
                  type="button"
                  variant={index === active ? "secondary" : "ghost"}
                >
                  <span>{value ?? PROVIDER_DEFAULT}</span>
                </OctantButton>
              </li>
            ))}
        {rowCount === 0 ? (
          <li className="chat-composer__command-option" role="presentation">
            <span className="chat-composer__command-meta">No models match.</span>
          </li>
        ) : null}
      </ul>
    </div>
  );
}
