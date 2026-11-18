import type { ReactNode } from "react";
import { ListFilter } from "../ui/icons";
import { octantButtonClassName } from "../ui/base/OctantButton";
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

/**
 * The one "Filter" a page toolbar offers for everything beyond search: the
 * button reads "Filter" with the number of non-default choices, says the same
 * in its accessible name, and the menu ends with "Reset filters" while
 * anything is on, so a narrowed list never hides why it is short.
 */
export function FilterMenu(props: {
  readonly label?: string;
  /** How many choices differ from their defaults. */
  readonly count: number;
  readonly onReset: () => void;
  readonly children: ReactNode;
}) {
  const label = props.label ?? "Filter";
  return (
    <OctantMenuRoot>
      <OctantMenuTrigger
        aria-label={props.count === 0 ? label : `${label}, ${String(props.count)} active`}
        className={octantButtonClassName({ variant: "ghost", size: "sm" })}
      >
        <ListFilter aria-hidden="true" size={14} />
        {label}
        {/* Always drawn, so the button keeps one width whether or not a filter is on. */}
        <span
          aria-hidden="true"
          className="filter-menu__count"
          data-empty={props.count === 0 ? "true" : undefined}
        >
          {String(props.count)}
        </span>
      </OctantMenuTrigger>
      <OctantMenuPortal>
        <OctantMenuPositioner align="end" className="outline-none window-no-drag">
          <OctantMenuPopup aria-label={label} className="min-w-[14rem]">
            {props.children}
            {props.count === 0 ? null : (
              <>
                <OctantMenuSeparator />
                <OctantMenuItem onClick={props.onReset}>Reset filters</OctantMenuItem>
              </>
            )}
          </OctantMenuPopup>
        </OctantMenuPositioner>
      </OctantMenuPortal>
    </OctantMenuRoot>
  );
}

/** A labelled single-choice group of a Filter menu; the menu stays open so choices can combine. */
export function FilterMenuGroup<T extends string>(props: {
  readonly label: string;
  readonly options: ReadonlyArray<{ readonly value: T; readonly label: string }>;
  readonly value: T;
  readonly onChange: (value: T) => void;
  /** Draws a rule above the group; the first group of a menu has none. */
  readonly separated?: boolean;
  readonly closeOnClick?: boolean;
}) {
  return (
    <>
      {props.separated === true ? <OctantMenuSeparator /> : null}
      <OctantMenuGroup>
        <OctantMenuGroupLabel>{props.label}</OctantMenuGroupLabel>
        <OctantMenuRadioGroup
          onValueChange={(value) => {
            const next = props.options.find((option) => option.value === value);
            if (next !== undefined) props.onChange(next.value);
          }}
          value={props.value}
        >
          {props.options.map((option) => (
            <OctantMenuRadioItem
              closeOnClick={props.closeOnClick ?? false}
              key={option.value}
              label={option.label}
              value={option.value}
            >
              {option.label}
            </OctantMenuRadioItem>
          ))}
        </OctantMenuRadioGroup>
      </OctantMenuGroup>
    </>
  );
}
