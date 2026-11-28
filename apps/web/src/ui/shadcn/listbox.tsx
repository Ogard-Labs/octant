import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ComponentProps,
  type KeyboardEvent,
  type ReactNode,
  type Ref,
  type RefObject,
} from "react";
import { buttonVariants, type ButtonProps } from "./button";
import { Input, type InputProps } from "./input";
import { cn } from "./utils";

const TYPEAHEAD_RESET_MS = 500;

function isDisabledElement(element: HTMLElement): boolean {
  return element.matches(':disabled, [aria-disabled="true"]');
}

function isPrintableCharacter(event: KeyboardEvent<HTMLElement>): boolean {
  return (
    event.key.length === 1 && !event.altKey && !event.ctrlKey && !event.metaKey && event.key !== " "
  );
}

function optionText(element: HTMLElement): string {
  return (element.getAttribute("aria-label") ?? element.textContent ?? "").trim().toLowerCase();
}

function findNextEnabledIndex(
  count: number,
  start: number,
  delta: 1 | -1,
  loop: boolean,
  isIndexDisabled?: (index: number) => boolean,
): number {
  if (count <= 0) return -1;
  const disabled = isIndexDisabled ?? (() => false);
  let cursor = start;
  for (let step = 0; step < count; step += 1) {
    if (cursor < 0) {
      cursor = delta > 0 ? 0 : count - 1;
    } else {
      const next = cursor + delta;
      if (next < 0 || next >= count) {
        if (!loop) return -1;
        cursor = (next + count) % count;
      } else {
        cursor = next;
      }
    }
    if (!disabled(cursor)) return cursor;
  }
  return -1;
}

function findEdgeEnabledIndex(
  count: number,
  edge: "first" | "last",
  isIndexDisabled?: (index: number) => boolean,
): number {
  if (count <= 0) return -1;
  const disabled = isIndexDisabled ?? (() => false);
  if (edge === "first") {
    for (let i = 0; i < count; i += 1) {
      if (!disabled(i)) return i;
    }
    return -1;
  }
  for (let i = count - 1; i >= 0; i -= 1) {
    if (!disabled(i)) return i;
  }
  return -1;
}

export interface ListboxControllerOptions {
  readonly count: number;
  readonly activeIndex?: number | undefined;
  readonly initialActiveIndex?: number | undefined;
  readonly onActiveIndexChange?: ((index: number) => void) | undefined;
  readonly onActivate?: ((index: number) => void) | undefined;
  readonly onDismiss?: (() => void) | undefined;
  readonly orientation?: "vertical" | "horizontal" | undefined;
  readonly loop?: boolean | undefined;
  readonly disabled?: boolean | undefined;
  readonly allowHomeEnd?: boolean | ((event: KeyboardEvent<HTMLElement>) => boolean) | undefined;
  readonly allowTabActivate?: boolean | undefined;
  readonly allowSpaceActivate?:
    | boolean
    | ((event: KeyboardEvent<HTMLElement>) => boolean)
    | undefined;
  readonly stopEscapePropagation?: boolean | undefined;
  readonly isIndexDisabled?: ((index: number) => boolean) | undefined;
  readonly getOptionLabel?: ((index: number) => string) | undefined;
  readonly onKeyboardMove?: (() => void) | undefined;
  readonly onMoveBeforeFirst?: (() => void) | undefined;
}

export interface ListboxController {
  readonly activeIndex: number;
  readonly setActiveIndex: (next: number | ((current: number) => number)) => void;
  readonly handleKeyDown: (event: KeyboardEvent<HTMLElement>) => boolean;
}

/**
 * Shared keyboard model for virtual-focus listboxes, comboboxes, and caret
 * typeaheads: Arrow keys move, Home and End jump, optional typeahead jumps by
 * prefix, Enter (and optionally Tab/Space) activates, Escape dismisses.
 */
export function useListboxController(options: ListboxControllerOptions): ListboxController {
  const [uncontrolledIndex, setUncontrolledIndex] = useState(options.initialActiveIndex ?? 0);
  const controlled = options.activeIndex !== undefined;
  const rawIndex = controlled ? options.activeIndex : uncontrolledIndex;
  const activeIndex =
    options.count === 0 ? -1 : rawIndex < 0 ? -1 : Math.min(rawIndex, options.count - 1);

  const typeaheadRef = useRef<{ buffer: string; timer: ReturnType<typeof setTimeout> | undefined }>(
    { buffer: "", timer: undefined },
  );

  useEffect(() => {
    const state = typeaheadRef.current;
    return () => {
      if (state.timer !== undefined) clearTimeout(state.timer);
    };
  }, []);

  const setActiveIndex = useCallback(
    (next: number | ((current: number) => number)) => {
      const resolved = typeof next === "function" ? next(activeIndex) : next;
      if (controlled) {
        options.onActiveIndexChange?.(resolved);
      } else {
        setUncontrolledIndex(resolved);
        options.onActiveIndexChange?.(resolved);
      }
    },
    [activeIndex, controlled, options],
  );

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLElement>): boolean => {
      if (options.disabled === true || event.nativeEvent.isComposing) return false;

      if (event.key === "Escape" && options.onDismiss !== undefined) {
        event.preventDefault();
        if (options.stopEscapePropagation === true) event.stopPropagation();
        options.onDismiss();
        return true;
      }

      if (options.count <= 0) return false;

      const orientation = options.orientation ?? "vertical";
      const nextKey = orientation === "horizontal" ? "ArrowRight" : "ArrowDown";
      const prevKey = orientation === "horizontal" ? "ArrowLeft" : "ArrowUp";
      const loop = options.loop ?? true;

      if (event.key === nextKey) {
        event.preventDefault();
        options.onKeyboardMove?.();
        const next = findNextEnabledIndex(
          options.count,
          activeIndex,
          1,
          loop,
          options.isIndexDisabled,
        );
        if (next >= 0) setActiveIndex(next);
        return true;
      }

      if (event.key === prevKey) {
        event.preventDefault();
        options.onKeyboardMove?.();
        const firstEnabled = findEdgeEnabledIndex(options.count, "first", options.isIndexDisabled);
        if (options.onMoveBeforeFirst !== undefined && activeIndex === firstEnabled) {
          options.onMoveBeforeFirst();
          return true;
        }
        const prev = findNextEnabledIndex(
          options.count,
          activeIndex,
          -1,
          loop,
          options.isIndexDisabled,
        );
        if (prev >= 0) setActiveIndex(prev);
        return true;
      }

      const homeEndAllowed =
        typeof options.allowHomeEnd === "function"
          ? options.allowHomeEnd(event)
          : (options.allowHomeEnd ?? true);

      if (homeEndAllowed && event.key === "Home") {
        event.preventDefault();
        options.onKeyboardMove?.();
        const first = findEdgeEnabledIndex(options.count, "first", options.isIndexDisabled);
        if (first >= 0) setActiveIndex(first);
        return true;
      }

      if (homeEndAllowed && event.key === "End") {
        event.preventDefault();
        options.onKeyboardMove?.();
        const last = findEdgeEnabledIndex(options.count, "last", options.isIndexDisabled);
        if (last >= 0) setActiveIndex(last);
        return true;
      }

      const spaceAllowed =
        typeof options.allowSpaceActivate === "function"
          ? options.allowSpaceActivate(event)
          : (options.allowSpaceActivate ?? false);

      if (
        (event.key === "Enter" && !event.shiftKey) ||
        (options.allowTabActivate === true && event.key === "Tab" && !event.shiftKey) ||
        (spaceAllowed && event.key === " ")
      ) {
        if (activeIndex >= 0 && options.onActivate !== undefined) {
          event.preventDefault();
          options.onActivate(activeIndex);
          return true;
        }
        return false;
      }

      if (options.getOptionLabel !== undefined && isPrintableCharacter(event)) {
        const state = typeaheadRef.current;
        if (state.timer !== undefined) clearTimeout(state.timer);
        state.buffer += event.key.toLowerCase();
        state.timer = setTimeout(() => {
          state.buffer = "";
          state.timer = undefined;
        }, TYPEAHEAD_RESET_MS);
        const start = activeIndex >= 0 ? (activeIndex + 1) % options.count : 0;
        for (let offset = 0; offset < options.count; offset += 1) {
          const candidate = (start + offset) % options.count;
          if (options.isIndexDisabled?.(candidate) === true) continue;
          if (options.getOptionLabel(candidate).toLowerCase().startsWith(state.buffer)) {
            event.preventDefault();
            options.onKeyboardMove?.();
            setActiveIndex(candidate);
            return true;
          }
        }
      }

      return false;
    },
    [activeIndex, options, setActiveIndex],
  );

  return { activeIndex, setActiveIndex, handleKeyDown };
}

function assignRef<T>(ref: Ref<T> | undefined, value: T | null): void {
  if (typeof ref === "function") {
    ref(value);
  } else if (ref !== undefined && ref !== null) {
    (ref as RefObject<T | null>).current = value;
  }
}

export interface ListboxProps {
  readonly as?: "div" | "ul" | undefined;
  readonly navigation?: "virtual" | "roving" | undefined;
  readonly orientation?: "vertical" | "horizontal" | undefined;
  readonly loop?: boolean | undefined;
  readonly typeahead?: boolean | undefined;
  readonly itemSelector?: string | undefined;
  readonly activeDescendantId?: string | undefined;
  readonly scrollActiveIntoView?: boolean | undefined;
  readonly onMoveBeforeFirst?: (() => void) | undefined;
  readonly "aria-label"?: string | undefined;
  readonly "aria-labelledby"?: string | undefined;
  readonly "aria-multiselectable"?: boolean | "true" | "false" | undefined;
  readonly className?: string | undefined;
  readonly id?: string | undefined;
  readonly tabIndex?: number | undefined;
  readonly onKeyDown?: ((event: KeyboardEvent<HTMLElement>) => void) | undefined;
  readonly ref?: Ref<HTMLElement> | undefined;
  readonly children?: ReactNode;
}

/**
 * Shared listbox container.
 *
 * - `navigation="virtual"` (default): pairs with `useListboxController` and an
 *   input or `tabIndex={0}` root using `aria-activedescendant`. Scrolls the
 *   active descendant into view automatically.
 * - `navigation="roving"`: manages roving `tabIndex` (Tab lands on the group
 *   once), Arrow/Home/End movement, and prefix typeahead directly across its
 *   enabled options.
 */
export function Listbox({
  as = "div",
  navigation = "virtual",
  orientation = "vertical",
  loop = true,
  typeahead,
  itemSelector = '[role="option"]',
  activeDescendantId,
  scrollActiveIntoView = true,
  onMoveBeforeFirst,
  className,
  onKeyDown,
  ref,
  children,
  ...rest
}: ListboxProps) {
  const containerRef = useRef<HTMLElement | null>(null);
  const typeaheadRef = useRef<{ buffer: string; timer: ReturnType<typeof setTimeout> | undefined }>(
    { buffer: "", timer: undefined },
  );

  useEffect(() => {
    const state = typeaheadRef.current;
    return () => {
      if (state.timer !== undefined) clearTimeout(state.timer);
    };
  }, []);

  // Keep the active descendant visible during virtual-focus keyboard movement.
  useEffect(() => {
    if (!scrollActiveIntoView || activeDescendantId === undefined) return;
    document.getElementById(activeDescendantId)?.scrollIntoView?.({ block: "nearest" });
  }, [activeDescendantId, scrollActiveIntoView]);

  // Synchronize roving tabIndex so Tab enters the listbox once on the selected
  // (or currently focused, or first enabled) option.
  const syncRovingTabIndex = useCallback(
    (focusedItem?: HTMLElement) => {
      if (navigation !== "roving") return;
      const root = containerRef.current;
      if (root === null) return;
      const items = Array.from(root.querySelectorAll<HTMLElement>(itemSelector));
      const enabled = items.filter((item) => !isDisabledElement(item));
      const active =
        (focusedItem !== undefined && enabled.includes(focusedItem) ? focusedItem : undefined) ??
        enabled.find((item) => item === document.activeElement) ??
        enabled.find((item) => item.getAttribute("aria-selected") === "true") ??
        enabled[0];
      for (const item of items) {
        const nextTabIndex = item === active ? 0 : -1;
        if (item.tabIndex !== nextTabIndex) item.tabIndex = nextTabIndex;
      }
    },
    [itemSelector, navigation],
  );

  useLayoutEffect(() => {
    syncRovingTabIndex();
  });

  const handleRovingKeyDown = useCallback(
    (event: KeyboardEvent<HTMLElement>) => {
      onKeyDown?.(event);
      if (event.defaultPrevented || navigation !== "roving" || event.nativeEvent.isComposing) {
        return;
      }
      const root = containerRef.current;
      if (root === null) return;
      const enabled = Array.from(root.querySelectorAll<HTMLElement>(itemSelector)).filter(
        (item) => !isDisabledElement(item),
      );
      if (enabled.length === 0) return;

      const currentIndex = enabled.findIndex((item) => item === event.target);
      if (currentIndex < 0) return;

      const nextKey = orientation === "horizontal" ? "ArrowRight" : "ArrowDown";
      const prevKey = orientation === "horizontal" ? "ArrowLeft" : "ArrowUp";

      let target: HTMLElement | undefined;
      if (event.key === nextKey) {
        const next = currentIndex + 1;
        target = next < enabled.length ? enabled[next] : loop ? enabled[0] : enabled[currentIndex];
      } else if (event.key === prevKey) {
        if (currentIndex === 0 && onMoveBeforeFirst !== undefined) {
          event.preventDefault();
          onMoveBeforeFirst();
          return;
        }
        const prev = currentIndex - 1;
        target = prev >= 0 ? enabled[prev] : loop ? enabled[enabled.length - 1] : enabled[0];
      } else if (event.key === "Home") {
        target = enabled[0];
      } else if (event.key === "End") {
        target = enabled[enabled.length - 1];
      } else if ((typeahead ?? true) && isPrintableCharacter(event)) {
        const state = typeaheadRef.current;
        if (state.timer !== undefined) clearTimeout(state.timer);
        state.buffer += event.key.toLowerCase();
        state.timer = setTimeout(() => {
          state.buffer = "";
          state.timer = undefined;
        }, TYPEAHEAD_RESET_MS);
        for (let offset = 1; offset <= enabled.length; offset += 1) {
          const candidate = enabled[(currentIndex + offset) % enabled.length];
          if (candidate !== undefined && optionText(candidate).startsWith(state.buffer)) {
            target = candidate;
            break;
          }
        }
      }

      if (target === undefined) return;
      event.preventDefault();
      syncRovingTabIndex(target);
      target.focus();
      target.scrollIntoView?.({ block: "nearest" });
    },
    [
      itemSelector,
      loop,
      navigation,
      onKeyDown,
      onMoveBeforeFirst,
      orientation,
      syncRovingTabIndex,
      typeahead,
    ],
  );

  const handleFocusCapture = useCallback(
    (event: React.FocusEvent<HTMLElement>) => {
      if (navigation !== "roving") return;
      const target = event.target;
      if (
        target instanceof HTMLElement &&
        target.matches(itemSelector) &&
        !isDisabledElement(target)
      ) {
        syncRovingTabIndex(target);
      }
    },
    [itemSelector, navigation, syncRovingTabIndex],
  );

  const sharedProps = {
    ...rest,
    ...(activeDescendantId === undefined ? {} : { "aria-activedescendant": activeDescendantId }),
    ...(orientation === "horizontal" ? { "aria-orientation": "horizontal" as const } : {}),
    className: cn("window-no-drag", className),
    "data-slot": "listbox",
    onFocusCapture: handleFocusCapture,
    onKeyDown: handleRovingKeyDown,
    ref: (node: HTMLElement | null) => {
      containerRef.current = node;
      assignRef(ref, node);
    },
    role: "listbox" as const,
  };

  if (as === "ul") {
    return <ul {...sharedProps}>{children}</ul>;
  }
  return <div {...sharedProps}>{children}</div>;
}

export type ListboxOptionProps = {
  readonly as?: "button" | "div" | "li" | undefined;
  readonly selected?: boolean | undefined;
  readonly active?: boolean | undefined;
  readonly variant?: ButtonProps["variant"] | undefined;
  readonly size?: ButtonProps["size"] | undefined;
  readonly disabled?: boolean | undefined;
  readonly "aria-disabled"?: boolean | "true" | "false" | undefined;
  readonly "aria-label"?: string | undefined;
  readonly "aria-labelledby"?: string | undefined;
  readonly "aria-describedby"?: string | undefined;
  readonly "aria-description"?: string | undefined;
  readonly "aria-keyshortcuts"?: string | undefined;
  readonly className?: string | undefined;
  readonly id?: string | undefined;
  readonly tabIndex?: number | undefined;
  readonly title?: string | undefined;
  readonly "data-active"?: boolean | string | undefined;
  readonly "data-archived"?: boolean | undefined;
  readonly "data-content"?: boolean | undefined;
  readonly onClick?: ((event: React.MouseEvent<HTMLElement>) => void) | undefined;
  readonly onKeyDown?: ((event: KeyboardEvent<HTMLElement>) => void) | undefined;
  readonly onMouseDown?: ((event: React.MouseEvent<HTMLElement>) => void) | undefined;
  readonly onMouseEnter?: ((event: React.MouseEvent<HTMLElement>) => void) | undefined;
  readonly onMouseMove?: ((event: React.MouseEvent<HTMLElement>) => void) | undefined;
  readonly onPointerEnter?: ((event: React.PointerEvent<HTMLElement>) => void) | undefined;
  readonly children?: ReactNode;
};

export function ListboxOption({
  as = "button",
  selected = false,
  active,
  variant,
  size,
  disabled,
  className,
  tabIndex,
  "data-active": dataActive,
  children,
  ...rest
}: ListboxOptionProps) {
  const resolvedDataActive =
    dataActive !== undefined ? dataActive : active === true ? "true" : undefined;

  if (as === "div") {
    return (
      <div
        aria-selected={selected}
        className={cn(className)}
        data-active={resolvedDataActive}
        data-slot="listbox-option"
        role="option"
        {...(tabIndex === undefined ? {} : { tabIndex })}
        {...rest}
      >
        {children}
      </div>
    );
  }

  if (as === "li") {
    return (
      <li
        aria-selected={selected}
        className={cn(className)}
        data-active={resolvedDataActive}
        data-slot="listbox-option"
        role="option"
        {...(tabIndex === undefined ? {} : { tabIndex })}
        {...rest}
      >
        {children}
      </li>
    );
  }

  const buttonStyle =
    variant !== undefined || size !== undefined
      ? buttonVariants({
          variant: variant ?? "bare",
          ...(size === undefined ? {} : { size }),
        })
      : buttonVariants({ variant: "bare" });

  return (
    <button
      aria-selected={selected}
      className={cn(buttonStyle, "window-no-drag", className)}
      data-active={resolvedDataActive}
      data-slot="listbox-option"
      disabled={disabled}
      role="option"
      tabIndex={tabIndex ?? -1}
      type="button"
      {...rest}
    >
      {children}
    </button>
  );
}

export type ListboxComboboxInputProps = Omit<InputProps, "role"> & {
  readonly activeDescendantId?: string | undefined;
  readonly controlsId: string;
  readonly expanded: boolean;
  readonly ref?: ComponentProps<"input">["ref"] | undefined;
};

export function ListboxComboboxInput({
  activeDescendantId,
  controlsId,
  expanded,
  className,
  ...props
}: ListboxComboboxInputProps) {
  // Keep the highlighted option visible when virtual focus lives on the input.
  useEffect(() => {
    if (activeDescendantId === undefined) return;
    document.getElementById(activeDescendantId)?.scrollIntoView?.({ block: "nearest" });
  }, [activeDescendantId]);

  return (
    <Input
      aria-controls={controlsId}
      aria-expanded={expanded}
      {...(activeDescendantId === undefined ? {} : { "aria-activedescendant": activeDescendantId })}
      className={cn("window-no-drag", className)}
      role="combobox"
      {...props}
    />
  );
}
