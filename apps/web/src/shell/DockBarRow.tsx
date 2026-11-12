import { ChevronDown, Ellipsis } from "lucide-react";
import {
  useLayoutEffect,
  useState,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from "react";
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
import { OctantButton } from "../ui/base/OctantButton";
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
 * (`named`), with the actions folded into one menu as well (`menu`), or with
 * the controls the tool draws itself moved to a row of their own under the
 * bar (`row`). The tool's name is cut only after the last step, and status
 * text and a state kept in words (View only) never fold.
 */
export type DockBarFold = "full" | "named" | "menu" | "row";

const FOLDS: ReadonlyArray<DockBarFold> = ["full", "named", "menu", "row"];

const isAction = (item: DockBarItem): boolean =>
  (item.kind === "button" && item.words !== true) || item.kind === "menu";
const isWords = (item: DockBarItem) => item.kind === "button" && item.words === true;
const isSwitch = (item: DockBarItem): item is DockBarChoice =>
  item.kind === "choice" && item.compact !== true;

type Rulers = ReadonlyMap<string, number>;

function widthOf(items: ReadonlyArray<DockBarItem>, fold: DockBarFold, rulers: Rulers): number {
  const actions = items.filter(isAction);
  const moreWidth = fold !== "full" && fold !== "named" && actions.length > 0 ? GAP + CONTROL : 0;
  return (
    moreWidth +
    items.reduce((sum, item) => {
      if (isAction(item)) return fold === "menu" || fold === "row" ? sum : sum + GAP + CONTROL;
      if (item.kind === "node") return fold === "row" ? sum : sum + GAP + item.width;
      if (item.kind === "choice") {
        const named = fold !== "full" || item.compact === true;
        return sum + GAP + (rulers.get(`${named ? "named" : "full"}:${item.id}`) ?? 0);
      }
      // Status text and a state kept in words count in every step, so the
      // actions fold before either is cut.
      return sum + GAP + (rulers.get(`text:${item.id}`) ?? 0);
    }, 0)
  );
}

/**
 * The step at which a bar's controls fit beside the tool's name. Measured from
 * the bar's width, the name's natural width and the rulers' (the controls'
 * words laid out unseen), never from the controls as drawn, so folding them
 * cannot change the answer and flip back and forth. The rulers are watched as
 * well as the bar: a larger interface size or a late font changes the words'
 * widths without changing the bar's.
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
      item.kind === "text" ? item.text : 0,
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
      const fits = FOLDS.find((step) => widthOf(items, step, rulers) <= room);
      setFold(fits ?? "row");
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    for (const ruler of node.querySelectorAll("[data-ruler]")) observer.observe(ruler);
    return () => observer.disconnect();
    // `key` stands for everything about the items that changes their width.
  }, [bar, key, trailing]);
  return fold;
}

/** The words laid out unseen, so the bar knows how much room they need. */
function Rulers(props: { readonly items: ReadonlyArray<DockBarItem> }) {
  const measured = props.items.filter(
    (item) => item.kind === "choice" || item.kind === "text" || isWords(item),
  );
  if (measured.length === 0) return null;
  return (
    <div aria-hidden="true" className="dock-bar-rulers" inert>
      {measured.map((item) =>
        item.kind === "choice" ? (
          <span key={item.id}>
            <span className="dock-bar-switch" data-ruler={`full:${item.id}`}>
              {item.options.map((option) => (
                <span className="dock-bar-switch__option" key={option.id}>
                  {option.label}
                </span>
              ))}
            </span>
            <span className="dock-bar-named" data-ruler={`named:${item.id}`}>
              <span className="dock-bar-named__label">
                {item.options.find((option) => option.id === item.value)?.label}
              </span>
              <ChevronDown size={12} />
            </span>
          </span>
        ) : item.kind === "text" ? (
          <span className="dock-tile__tool-text" data-ruler={`text:${item.id}`} key={item.id}>
            {item.dot === undefined ? null : <span className="device-dot" />}
            {item.text}
          </span>
        ) : item.kind === "button" ? (
          <span className="dock-bar-chip" data-ruler={`text:${item.id}`} key={item.id}>
            {item.label}
          </span>
        ) : null,
      )}
    </div>
  );
}

function ChoiceMenu(props: { readonly choice: DockBarChoice }) {
  const { choice } = props;
  const current = choice.options.find((option) => option.id === choice.value);
  const name = `${current?.label ?? choice.label}, ${choice.label}`;
  return (
    <OctantMenuRoot>
      <OctantMenuTrigger aria-label={name} className="dock-bar-named window-no-drag" title={name}>
        <span className="dock-bar-named__label">{current?.label}</span>
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
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate">{option.label}</span>
                    {option.description === undefined ? null : (
                      <span className="truncate oct-menu-detail">{option.description}</span>
                    )}
                  </span>
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
 * Arrow keys move between a toolbar's controls, as a toolbar should; Tab still
 * leaves it. Disabled controls are skipped.
 */
function moveAlongToolbar(event: KeyboardEvent<HTMLDivElement>) {
  const forward = event.key === "ArrowRight";
  if (!forward && event.key !== "ArrowLeft" && event.key !== "Home" && event.key !== "End") return;
  const controls = [...event.currentTarget.querySelectorAll("button")].filter(
    (button) => !button.disabled && button.closest("[inert]") === null,
  );
  const at = controls.findIndex((button) => button === document.activeElement);
  if (at < 0) return;
  event.preventDefault();
  const next =
    event.key === "Home"
      ? 0
      : event.key === "End"
        ? controls.length - 1
        : (at + (forward ? 1 : -1) + controls.length) % controls.length;
  controls[next]?.focus();
}

/** The controls a tool draws itself, moved under the bar when the bar cannot hold them. */
export function DockBarNodes(props: { readonly items: ReadonlyArray<DockBarItem> }): ReactNode {
  return props.items.map((item) =>
    item.kind === "node" ? (
      <span className="dock-tile__tool-node" key={item.id}>
        {item.node}
      </span>
    ) : null,
  );
}

/**
 * A tool's bar controls, as one labelled toolbar. Navigation and status lead,
 * after the tool's name; actions trail, ending where the tile's own Arrange and
 * Close begin. Each action is a 24px icon button, folded into one menu when the
 * bar cannot hold them (see `DockBarFold`).
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
    <div
      aria-label={`${props.toolLabel} controls`}
      className="dock-tile__tool-controls"
      onKeyDown={moveAlongToolbar}
      role="toolbar"
    >
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
                {item.dot === undefined ? null : (
                  <span aria-hidden="true" className="device-dot" data-dot={item.dot} />
                )}
                {item.text}
              </span>
            );
          if (item.kind === "node")
            return props.fold === "row" ? null : (
              <span className="dock-tile__tool-node" key={item.id}>
                {item.node}
              </span>
            );
          if (item.kind === "button")
            return (
              <OctantButton
                aria-label={item.label}
                className="dock-bar-chip window-no-drag"
                disabled={item.disabled === true}
                key={item.id}
                onClick={item.onSelect}
                title={item.title ?? item.label}
                type="button"
                variant="bare"
              >
                {item.label}
              </OctantButton>
            );
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
          {props.fold === "menu" || props.fold === "row" ? (
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
