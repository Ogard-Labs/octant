import { Fragment, useEffect, useRef, useState, type ReactNode } from "react";
import {
  Select as AuthoredSelect,
  SelectGroup,
  SelectGroupLabel,
  SelectItem,
  SelectPopup,
  SelectPortal,
  SelectPositioner,
  SelectTrigger,
  SelectValue,
} from "../shadcn/select";
import { cn } from "../shadcn/utils";

export {
  AuthoredSelect as OctantSelectRoot,
  SelectGroup as OctantSelectGroup,
  SelectGroupLabel as OctantSelectGroupLabel,
  SelectItem as OctantSelectItem,
  SelectPopup as OctantSelectPopup,
  SelectPortal as OctantSelectPortal,
  SelectPositioner as OctantSelectPositioner,
  SelectTrigger as OctantSelectTrigger,
  SelectValue as OctantSelectValue,
};

export interface OctantSelectOption {
  readonly disabled?: boolean;
  readonly disabledReason?: string;
  readonly id: string;
  readonly label: string;
  /**
   * Options sharing a group render under one label, in the order groups first
   * appear. Ungrouped options render bare, so existing callers are unaffected.
   */
  readonly group?: string;
}

export interface OctantSelectFieldProps {
  readonly "aria-label"?: string;
  readonly "data-testid"?: string;
  readonly className?: string;
  readonly defaultValue?: string;
  readonly disabled?: boolean;
  readonly id?: string;
  readonly name?: string;
  readonly onValueChange?: (value: string) => void;
  readonly options: ReadonlyArray<OctantSelectOption>;
  readonly placeholder?: ReactNode;
  readonly triggerClassName?: string;
  readonly value?: string;
}

/**
 * Base UI rejects an empty item value, but product filters still use "" for
 * "all" / "default". Encode only at the recipe boundary.
 */
const EMPTY_SELECT_VALUE = "octant-select:empty";

function encodeSelectValue(id: string): string {
  return id === "" ? EMPTY_SELECT_VALUE : id;
}

function decodeSelectValue(value: string): string {
  return value === EMPTY_SELECT_VALUE ? "" : value;
}

interface OptionSegment {
  readonly group: string | undefined;
  readonly options: ReadonlyArray<OctantSelectOption>;
}

/** Consecutive options sharing a group become one segment, in first-seen order. */
function segmentOptions(options: ReadonlyArray<OctantSelectOption>): ReadonlyArray<OptionSegment> {
  const segments: Array<{ group: string | undefined; options: Array<OctantSelectOption> }> = [];
  for (const option of options) {
    const last = segments.at(-1);
    if (last !== undefined && last.group === option.group) {
      last.options.push(option);
      continue;
    }
    segments.push({ group: option.group, options: [option] });
  }
  return segments;
}

/**
 * Convenience select for product forms. Compound primitives remain available
 * for advanced layouts.
 */
export function OctantSelectField(props: OctantSelectFieldProps) {
  const initialValue = props.defaultValue ?? props.value ?? props.options[0]?.id ?? "";
  const [uncontrolledValue, setUncontrolledValue] = useState(initialValue);
  const rootRef = useRef<HTMLSpanElement>(null);
  const selectedId = props.value ?? uncontrolledValue;
  const selectedOption = props.options.find((option) => option.id === selectedId);

  useEffect(() => {
    if (props.value !== undefined) return undefined;
    const form = rootRef.current?.closest("form");
    if (form === null || form === undefined) return undefined;
    const onReset = () => {
      setUncontrolledValue(props.defaultValue ?? props.options[0]?.id ?? "");
    };
    form.addEventListener("reset", onReset);
    return () => form.removeEventListener("reset", onReset);
  }, [props.defaultValue, props.options, props.value]);

  return (
    <span className="contents" ref={rootRef}>
      <AuthoredSelect
        disabled={props.disabled}
        onValueChange={(value) => {
          if (typeof value !== "string") return;
          const next = decodeSelectValue(value);
          if (props.value === undefined) setUncontrolledValue(next);
          props.onValueChange?.(next);
        }}
        value={encodeSelectValue(selectedId)}
      >
        <SelectTrigger
          {...(props["aria-label"] === undefined ? {} : { "aria-label": props["aria-label"] })}
          {...(props["data-testid"] === undefined ? {} : { "data-testid": props["data-testid"] })}
          className={cn("window-no-drag", props.triggerClassName, props.className)}
          {...(props.id === undefined ? {} : { id: props.id })}
        >
          <SelectValue placeholder={props.placeholder}>{selectedOption?.label}</SelectValue>
        </SelectTrigger>
        <SelectPortal>
          <SelectPositioner
            alignItemWithTrigger={false}
            className="z-50 outline-none window-no-drag"
            sideOffset={4}
          >
            <SelectPopup>
              {segmentOptions(props.options).map((segment, index) => {
                const items = segment.options.map((option) => (
                  <SelectItem
                    disabled={option.disabled}
                    key={encodeSelectValue(option.id)}
                    {...(option.disabledReason === undefined
                      ? {}
                      : { title: option.disabledReason })}
                    value={encodeSelectValue(option.id)}
                  >
                    {option.label}
                  </SelectItem>
                ));
                if (segment.group === undefined) {
                  return <Fragment key={`ungrouped-${index}`}>{items}</Fragment>;
                }
                return (
                  <SelectGroup key={`${segment.group}-${index}`}>
                    <SelectGroupLabel>{segment.group}</SelectGroupLabel>
                    {items}
                  </SelectGroup>
                );
              })}
            </SelectPopup>
          </SelectPositioner>
        </SelectPortal>
      </AuthoredSelect>
      {props.name === undefined ? null : (
        <input name={props.name} type="hidden" value={selectedId} />
      )}
    </span>
  );
}
