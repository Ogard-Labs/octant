import { ChevronDown, Ellipsis } from "lucide-react";
import { useLayoutEffect, useState, type RefObject } from "react";
import {
  OctantMenuGroup,
  OctantMenuGroupLabel,
  OctantMenuItem,
  OctantMenuPopup,
  OctantMenuPortal,
  OctantMenuPositioner,
  OctantMenuRadioGroup,
  OctantMenuRadioItem,
  OctantMenuRoot,
  OctantMenuSeparator,
  OctantMenuTrigger,
} from "../ui/base/OctantMenu";
import { OctantToggleGroup, OctantToggleGroupItem } from "../ui/base/OctantToggleGroup";
import { IconButton } from "./IconButton";
import type { DockBarChoice, DockBarItem } from "./dockBarControls";

/** A 24px control, and the 4px between two. */
const CONTROL = 24;
const GAP = 4;
/** The bar's own inset: 12 leading, 8 trailing. */
const INSETS = 20;
/** Arrange and Close with the gaps around them. */
export const TILE_CONTROLS = 2 * CONTROL + 2 * GAP;

/**
 * How much of a tool's controls a bar shows: every control as it is (`full`),
 * with each view switch folded into one control that names the current view
 * (`named`), or with the actions folded into one menu as well (`menu`). The
 * tool's name is cut only after the last step.
 */
export type DockBarFold = "full" | "named" | "menu";

const isAction = (item: DockBarItem) => item.kind === "button" || item.kind === "menu";
const isSwitch = (item: DockBarItem): item is DockBarChoice =>
  item.kind === "choice" && item.compact !== true;

function widthOf(items: ReadonlyArray<DockBarItem>, fold: DockBarFold, rulers: Rulers): number {
  const actions = items.filter(isAction);
  const moreWidth = fold === "menu" && actions.length > 0 ? GAP + CONTROL : 0;
  return (
    moreWidth +
    items.reduce((sum, item) => {
      if (isAction(item)) return fold === "menu" ? sum : sum + GAP + CONTROL;
      if (item.kind === "node") return sum + GAP + item.width;
      if (item.kind === "choice") {
        const named = fold !== "full" || item.compact === true;
        return sum + GAP + (rulers.get(`${named ? "named" : "full"}:${item.id}`) ?? 0);
      }
      return sum;
    }, 0)
  );
}

type Rulers = ReadonlyMap<string, number>;

/**
 * The step at which a bar's controls fit beside the tool's name. Measured from
 * the bar's width, the name's natural width and the rulers' (the controls'
 * words laid out unseen), never from the controls as drawn, so folding them
 * cannot change the answer and flip back and forth.
 */
export function useFoldedControls(
  bar: RefObject<HTMLElement | null>,
  items: ReadonlyArray<DockBarItem>,
  trailing: number,
): DockBarFold {
  const [fold, setFold] = useState<DockBarFold>("full");
  const key = JSON.stringify(
    items.map((item) => [
      item.id,
      item.kind,
      item.kind === "choice" ? [item.value, item.options.map((option) => option.label)] : 0,
    ]),
  );
  useLayoutEffect(() => {
    const node = bar.current;
    if (node === null || items.length === 0) {
      setFold("full");
      return;
    }
    const measure = () => {
      // A bar with no measurable width (not laid out yet) folds nothing.
      if (node.clientWidth === 0) return setFold("full");
      const rulers = new Map<string, number>();
      for (const ruler of node.querySelectorAll<HTMLElement>("[data-ruler]")) {
        rulers.set(ruler.dataset.ruler ?? "", ruler.offsetWidth);
      }
      const name = node.querySelector<HTMLElement>(".dock-tile__name");
      const lead = name === null ? 0 : 14 + GAP + name.scrollWidth;
      const room = node.clientWidth - INSETS - lead - trailing;
      const steps: ReadonlyArray<DockBarFold> = ["full", "named", "menu"];
      const fits = steps.find((step) => widthOf(items, step, rulers) <= room);
      setFold(fits ?? "menu");
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
    // `key` stands for everything about the items that changes their width.
  }, [bar, key, trailing]);
  return fold;
}

/** The words of a choice laid out unseen, so the bar knows how much room they need. */
function Rulers(props: { readonly items: ReadonlyArray<DockBarItem> }) {
  const choices = props.items.filter((item): item is DockBarChoice => item.kind === "choice");
  if (choices.length === 0) return null;
  return (
    <div aria-hidden="true" className="dock-bar-rulers" inert>
      {choices.map((choice) => (
        <span key={choice.id}>
          <span className="dock-bar-switch" data-ruler={`full:${choice.id}`}>
            {choice.options.map((option) => (
              <span className="dock-bar-switch__option" key={option.id}>
                {option.label}
              </span>
            ))}
          </span>
          <span className="dock-bar-named" data-ruler={`named:${choice.id}`}>
            <span>{choice.options.find((option) => option.id === choice.value)?.label}</span>
            <ChevronDown size={12} />
          </span>
        </span>
      ))}
    </div>
  );
}

function ChoiceMenu(props: { readonly choice: DockBarChoice }) {
  const { choice } = props;
  const current = choice.options.find((option) => option.id === choice.value);
  const name = `${current?.label ?? choice.label}, ${choice.label}`;
  return (
    <OctantMenuRoot>
      <OctantMenuTrigger
        aria-label={name}
        className="dock-bar-named window-no-drag"
        title={choice.label}
      >
        <span>{current?.label}</span>
        <ChevronDown aria-hidden="true" size={12} />
      </OctantMenuTrigger>
      <OctantMenuPortal>
        <OctantMenuPositioner>
          <OctantMenuPopup aria-label={choice.label}>
            <OctantMenuRadioGroup
              onValueChange={(value) => choice.onChange(String(value))}
              value={choice.value}
            >
              {choice.options.map((option) => (
                <OctantMenuRadioItem
                  className="workspace-disclosure__action window-no-drag"
                  key={option.id}
                  value={option.id}
                >
                  <span>{option.label}</span>
                </OctantMenuRadioItem>
              ))}
            </OctantMenuRadioGroup>
          </OctantMenuPopup>
        </OctantMenuPositioner>
      </OctantMenuPortal>
    </OctantMenuRoot>
  );
}

function WordSwitch(props: { readonly choice: DockBarChoice }) {
  const { choice } = props;
  return (
    <OctantToggleGroup
      aria-label={choice.label}
      className="dock-bar-switch"
      onValueChange={(next) => {
        const selected = next[0];
        if (selected !== undefined && selected !== choice.value) choice.onChange(selected);
      }}
      value={[choice.value]}
    >
      {choice.options.map((option) => (
        <OctantToggleGroupItem
          className="dock-bar-switch__option"
          key={option.id}
          value={option.id}
        >
          {option.label}
        </OctantToggleGroupItem>
      ))}
    </OctantToggleGroup>
  );
}

function ActionMenu(props: { readonly item: Extract<DockBarItem, { kind: "menu" }> }) {
  const { item } = props;
  const Icon = item.icon;
  return (
    <OctantMenuRoot>
      <OctantMenuTrigger
        aria-label={item.label}
        className="shell-icon-button dock-tile__control window-no-drag"
        title={item.label}
      >
        <Icon aria-hidden="true" size={14} />
      </OctantMenuTrigger>
      <OctantMenuPortal>
        <OctantMenuPositioner>
          <OctantMenuPopup aria-label={item.label}>
            {item.items.map((entry) => (
              <OctantMenuItem
                className="workspace-disclosure__action window-no-drag"
                disabled={entry.disabled === true}
                key={entry.id}
                onClick={() => item.onSelect(entry.id)}
              >
                <span>{entry.label}</span>
              </OctantMenuItem>
            ))}
          </OctantMenuPopup>
        </OctantMenuPositioner>
      </OctantMenuPortal>
    </OctantMenuRoot>
  );
}

function MoreMenu(props: {
  readonly items: ReadonlyArray<DockBarItem>;
  readonly toolLabel: string;
}) {
  const name = `More ${props.toolLabel} actions`;
  return (
    <OctantMenuRoot>
      <OctantMenuTrigger
        aria-label={name}
        className="shell-icon-button dock-tile__control window-no-drag"
        title={name}
      >
        <Ellipsis aria-hidden="true" size={14} />
      </OctantMenuTrigger>
      <OctantMenuPortal>
        <OctantMenuPositioner>
          <OctantMenuPopup aria-label={name}>
            {props.items.filter(isAction).map((item, index) =>
              item.kind === "button" ? (
                <OctantMenuItem
                  className="workspace-disclosure__action window-no-drag"
                  disabled={item.disabled === true}
                  key={item.id}
                  onClick={item.onSelect}
                >
                  <span>{item.label}</span>
                </OctantMenuItem>
              ) : item.kind === "menu" ? (
                <OctantMenuGroup key={item.id}>
                  {index === 0 ? null : <OctantMenuSeparator />}
                  <OctantMenuGroupLabel>{item.label}</OctantMenuGroupLabel>
                  {item.items.map((entry) => (
                    <OctantMenuItem
                      className="workspace-disclosure__action window-no-drag"
                      disabled={entry.disabled === true}
                      key={entry.id}
                      onClick={() => item.onSelect(entry.id)}
                    >
                      <span>{entry.label}</span>
                    </OctantMenuItem>
                  ))}
                </OctantMenuGroup>
              ) : null,
            )}
          </OctantMenuPopup>
        </OctantMenuPositioner>
      </OctantMenuPortal>
    </OctantMenuRoot>
  );
}

/**
 * A tool's bar controls. Navigation and status lead, after the tool's name;
 * actions trail, ending where the tile's own Arrange and Close begin. Each
 * action is a 24px icon button, folded into one menu when the bar cannot hold
 * them (see `DockBarFold`).
 */
export function DockBarRow(props: {
  readonly items: ReadonlyArray<DockBarItem>;
  readonly fold: DockBarFold;
  readonly toolLabel: string;
}) {
  if (props.items.length === 0) return null;
  const actions = props.items.filter(isAction);
  const lead = props.items.filter((item) => !isAction(item));
  return (
    <div className="dock-tile__tool-controls">
      <Rulers items={props.items} />
      <div className="dock-tile__tool-lead">
        {lead.map((item) => {
          if (item.kind === "text")
            return (
              <span
                aria-live={item.live === true ? "polite" : undefined}
                className="dock-tile__tool-text"
                key={item.id}
              >
                {item.text}
              </span>
            );
          if (item.kind === "node") return <span key={item.id}>{item.node}</span>;
          if (item.kind !== "choice") return null;
          return props.fold === "full" && isSwitch(item) ? (
            <WordSwitch choice={item} key={item.id} />
          ) : (
            <ChoiceMenu choice={item} key={item.id} />
          );
        })}
      </div>
      {actions.length === 0 ? null : (
        <div className="dock-tile__tool-actions">
          {props.fold === "menu" ? (
            <MoreMenu items={props.items} toolLabel={props.toolLabel} />
          ) : (
            actions.map((item) =>
              item.kind === "button" ? (
                <IconButton
                  className="dock-tile__control window-no-drag"
                  disabled={item.disabled === true}
                  icon={item.icon}
                  key={item.id}
                  label={item.label}
                  onClick={item.onSelect}
                  {...(item.title === undefined ? {} : { title: item.title })}
                />
              ) : item.kind === "menu" ? (
                <ActionMenu item={item} key={item.id} />
              ) : null,
            )
          )}
        </div>
      )}
    </div>
  );
}
