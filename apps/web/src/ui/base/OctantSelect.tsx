import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectPortal,
  SelectPositioner,
  SelectTrigger,
  SelectValue,
} from "../shadcn/select";
import { cn } from "../shadcn/utils";

export {
  Select as OctantSelectRoot,
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
      <Select
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
          <SelectPositioner className="z-50 outline-none window-no-drag" sideOffset={4}>
            <SelectPopup>
              {props.options.map((option) => (
                <SelectItem
                  disabled={option.disabled}
                  key={encodeSelectValue(option.id)}
                  {...(option.disabledReason === undefined ? {} : { title: option.disabledReason })}
                  value={encodeSelectValue(option.id)}
                >
                  {option.label}
                </SelectItem>
              ))}
            </SelectPopup>
          </SelectPositioner>
        </SelectPortal>
      </Select>
      {props.name === undefined ? null : (
        <input name={props.name} type="hidden" value={selectedId} />
      )}
    </span>
  );
}
