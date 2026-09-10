import {
  createContext,
  useCallback,
  useContext,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { Monitor, X } from "lucide-react";
import type { ExtensionSelection } from "@octant/contracts/extensions";
import { computerUseSelection } from "@octant/plugin-host/computer-use";
import { OctantButton } from "../ui/base/OctantButton";

interface Token {
  readonly start: number;
  readonly end: number;
  readonly raw: string;
  readonly scope: string;
}
export const ComputerUseEnabledContext = createContext(true);
export const useComputerUseEnabled = () => useContext(ComputerUseEnabledContext);

export function useComputerUseMention(input: {
  readonly draft: string;
  readonly onDraftChange: (draft: string, caret?: number) => void;
  readonly scopeKey: string;
  readonly available?: boolean;
  readonly onChoose?: () => void;
  readonly onSelectionEdited?: () => void;
  readonly textarea?: () => HTMLTextAreaElement | null;
}) {
  const listId = useId();
  const [token, setToken] = useState<Token>();
  const [chosen, setChosen] = useState<{
    readonly scope: string;
    readonly selection: ExtensionSelection;
  }>();
  const enabled = useComputerUseEnabled();
  const available =
    enabled &&
    (input.available ??
      (typeof window !== "undefined" &&
        typeof window.octantHost?.getComputerUseStatus === "function"));
  const selection = chosen?.scope === input.scopeKey ? chosen.selection : undefined;
  const scopeKey = input.scopeKey;
  const currentScope = useRef(scopeKey);
  currentScope.current = scopeKey;
  const consume = useCallback(
    (selection: ExtensionSelection | undefined) =>
      setChosen((current) =>
        current?.scope === scopeKey && current.selection === selection ? undefined : current,
      ),
    [scopeKey],
  );
  const restore = useCallback(
    (selection: ExtensionSelection | undefined) =>
      setChosen(selection === undefined ? undefined : { scope: scopeKey, selection }),
    [scopeKey],
  );
  const open =
    available &&
    token?.scope === input.scopeKey &&
    input.draft.slice(token.start, token.end) === token.raw;
  const clear = () => {
    input.onSelectionEdited?.();
    setChosen(undefined);
    setToken(undefined);
  };
  const choose = () => {
    if (!open || token === undefined) return;
    const next = input.draft.slice(0, token.start) + input.draft.slice(token.end);
    input.onDraftChange(next, token.start);
    if (input.onChoose === undefined)
      setChosen({ scope: input.scopeKey, selection: computerUseSelection(crypto.randomUUID()) });
    else input.onChoose();
    setToken(undefined);
    const caret = token.start;
    queueMicrotask(() => {
      if (currentScope.current !== scopeKey) return;
      const textarea = input.textarea?.();
      textarea?.focus();
      textarea?.setSelectionRange(caret, caret);
    });
  };
  return {
    open,
    available,
    selection,
    choose,
    clear,
    listId,
    consume,
    restore,
    sync: (draft: string, caret: number | null) => {
      if (caret === null || !available) {
        setToken(undefined);
        return;
      }
      const match = /(?:^|\s)@([a-z]*)$/i.exec(draft.slice(0, caret));
      const query = match?.[1];
      setToken(
        query !== undefined && "computer".startsWith(query.toLowerCase())
          ? { start: caret - query.length - 1, end: caret, raw: `@${query}`, scope: input.scopeKey }
          : undefined,
      );
    },
    handleKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>): boolean => {
      if (!open || event.nativeEvent.isComposing) return false;
      if ((event.key === "Enter" || event.key === "Tab") && !event.shiftKey) {
        event.preventDefault();
        choose();
        return true;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        setToken(undefined);
        return true;
      }
      return false;
    },
  };
}

export function ComputerUseMention({
  controller,
  surface,
}: {
  readonly controller: ReturnType<typeof useComputerUseMention>;
  readonly surface?: "chips" | "typeahead";
}) {
  return (
    <>
      {controller.open && surface !== "chips" ? (
        <div className="thread-mention__typeahead">
          <div
            id={controller.listId}
            role="listbox"
            aria-label="Applications"
            className="thread-mention__list"
          >
            <OctantButton
              id={`${controller.listId}-computer`}
              role="option"
              aria-selected="true"
              type="button"
              variant="ghost"
              className="thread-mention__option"
              onMouseDown={(event) => event.preventDefault()}
              onClick={controller.choose}
            >
              <Monitor aria-hidden="true" size={16} />
              <span>Computer</span>
              <span className="thread-mention__meta">Computer use</span>
            </OctantButton>
          </div>
        </div>
      ) : null}
      {controller.selection === undefined || surface === "typeahead" ? null : (
        <ul aria-label="Selected applications" className="composer-chips">
          <li className="chip">
            <Monitor aria-hidden="true" size={16} />
            <span>Computer</span>
            <OctantButton
              className="chip-x window-no-drag"
              type="button"
              variant="ghost"
              aria-label="Remove Computer"
              onClick={controller.clear}
            >
              <X aria-hidden="true" size={12} />
            </OctantButton>
          </li>
        </ul>
      )}
    </>
  );
}
