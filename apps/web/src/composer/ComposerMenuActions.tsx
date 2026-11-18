import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { ComposerThreadAction } from "./ComposerAttachButton";

/**
 * What a thread offers in the box's + menu besides attachments: its info and,
 * where the thread can take one, a plan to propose. The control that owns the
 * panel or dialog registers the action, so the action and the thing it opens
 * stay in one component while the menu lists them.
 */
type Register = (key: string, action: ComposerThreadAction | undefined) => void;

// Two contexts: the controls that register never re-render when the list does.
const RegisterContext = createContext<Register | undefined>(undefined);
const ActionsContext = createContext<ReadonlyArray<ComposerThreadAction>>([]);

export function ComposerMenuActionProvider(props: {
  /** False while the + menu is not drawn (a held thread, no attach control): controls keep their own button. */
  readonly offered: boolean;
  readonly children: ReactNode;
}) {
  const [entries, setEntries] = useState<ReadonlyMap<string, ComposerThreadAction>>(new Map());
  const register = useCallback((key: string, action: ComposerThreadAction | undefined) => {
    setEntries((current) => {
      const existing = current.get(key);
      if (action === undefined && existing === undefined) return current;
      if (
        action !== undefined &&
        existing !== undefined &&
        existing.label === action.label &&
        existing.disabled === action.disabled &&
        existing.onSelect === action.onSelect
      ) {
        return current;
      }
      const next = new Map(current);
      if (action === undefined) next.delete(key);
      else next.set(key, action);
      return next;
    });
  }, []);
  const actions = useMemo(() => [...entries.values()], [entries]);
  return (
    <RegisterContext.Provider value={props.offered ? register : undefined}>
      <ActionsContext.Provider value={actions}>{props.children}</ActionsContext.Provider>
    </RegisterContext.Provider>
  );
}

/** The actions registered by the composer's controls, in the order they registered. */
export function useComposerMenuActions(): ReadonlyArray<ComposerThreadAction> {
  return useContext(ActionsContext);
}

/**
 * Offers `action` in the + menu while this component is mounted. Pass
 * `undefined` to withdraw it. Where no composer provides a menu the action is
 * simply not offered, so the caller keeps its own control.
 */
export function useRegisterComposerMenuAction(
  key: string,
  action: ComposerThreadAction | undefined,
): boolean {
  const register = useContext(RegisterContext);
  // The latest select wins without re-registering on every render.
  const onSelect = useRef(action?.onSelect);
  onSelect.current = action?.onSelect;
  const label = action?.label;
  const disabled = action?.disabled;
  const icon = useRef(action?.icon);
  icon.current = action?.icon;
  const offered = label !== undefined;
  const stable = useCallback(() => onSelect.current?.(), []);
  useEffect(() => {
    if (register === undefined) return undefined;
    register(
      key,
      label === undefined
        ? undefined
        : {
            label,
            ...(disabled === undefined ? {} : { disabled }),
            ...(icon.current === undefined ? {} : { icon: icon.current }),
            onSelect: stable,
          },
    );
    return () => register(key, undefined);
  }, [register, key, label, disabled, stable]);
  return register !== undefined && offered;
}
