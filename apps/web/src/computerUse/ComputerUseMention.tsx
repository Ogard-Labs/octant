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
import { Globe2 } from "lucide-react";
import type { ExtensionSelection } from "@octant/contracts/extensions";
import { computerUseSelection } from "@octant/plugin-host/computer-use";
import { browserUseSelection } from "@octant/plugin-host/browser-use";
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
  return useApplicationMention(input, {
    kind: "computer",
    label: "Computer",
    available:
      typeof window !== "undefined" && typeof window.octantHost?.getComputerUseStatus === "function",
  });
}

/** The same explicit mention surface for Octant's host-owned Browser. */
export function useBrowserUseMention(input: {
  readonly draft: string;
  readonly onDraftChange: (draft: string, caret?: number) => void;
  readonly scopeKey: string;
  readonly available?: boolean;
  readonly onChoose?: () => void;
  readonly onSelectionEdited?: () => void;
  readonly textarea?: () => HTMLTextAreaElement | null;
}) {
  return useApplicationMention(input, {
    kind: "browser",
    label: "Browser",
    available: input.available === true,
  });
}

function useApplicationMention(
  input: {
    readonly draft: string;
    readonly onDraftChange: (draft: string, caret?: number) => void;
    readonly scopeKey: string;
    readonly available?: boolean;
    readonly onChoose?: () => void;
    readonly onSelectionEdited?: () => void;
    readonly textarea?: () => HTMLTextAreaElement | null;
  },
  app: { readonly kind: "computer" | "browser"; readonly label: string; readonly available: boolean },
) {
  const listId = useId();
  const [token, setToken] = useState<Token>();
  const [chosen, setChosen] = useState<{
    readonly scope: string;
    readonly selection: ExtensionSelection;
  }>();
  const computerEnabled = useComputerUseEnabled();
  const enabled = app.kind === "browser" ? input.available === true : computerEnabled;
  const available = enabled && (input.available ?? app.available);
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
      setChosen({
        scope: input.scopeKey,
        selection:
          app.kind === "computer"
            ? computerUseSelection(crypto.randomUUID())
            : browserUseSelection(crypto.randomUUID()),
      });
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
        query !== undefined && app.label.toLowerCase().startsWith(query.toLowerCase())
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
  readonly surface?: "chips" | "typeahead" | undefined;
}) {
  return <ApplicationMention controller={controller} kind="computer" surface={surface} />;
}

export function BrowserUseMention({
  controller,
  surface,
}: {
  readonly controller: ReturnType<typeof useBrowserUseMention>;
  readonly surface?: "chips" | "typeahead" | undefined;
}) {
  return <ApplicationMention controller={controller} kind="browser" surface={surface} />;
}

function ApplicationMention({
  controller,
  kind,
  surface,
}: {
  readonly controller: {
    readonly open: boolean;
    readonly selection?: ExtensionSelection | undefined;
    readonly choose: () => void;
    readonly clear: () => void;
    readonly listId: string;
  };
  readonly kind: "computer" | "browser";
  readonly surface?: "chips" | "typeahead" | undefined;
}) {
  const label = kind === "computer" ? "Computer" : "Browser";
  const detail = kind === "computer" ? "Computer use" : "Built-in browser";
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
              id={`${controller.listId}-${kind}`}
              role="option"
              aria-selected="true"
              type="button"
              variant="ghost"
              className="thread-mention__option"
              onMouseDown={(event) => event.preventDefault()}
              onClick={controller.choose}
            >
              {kind === "computer" ? (
                <Monitor aria-hidden="true" size={16} />
              ) : (
                <Globe2 aria-hidden="true" size={16} />
              )}
              <span>{label}</span>
              <span className="thread-mention__meta">{detail}</span>
            </OctantButton>
          </div>
        </div>
      ) : null}
      {controller.selection === undefined || surface === "typeahead" ? null : (
        <ul aria-label="Selected applications" className="composer-chips">
          <li className="chip">
            {kind === "computer" ? (
              <Monitor aria-hidden="true" size={16} />
            ) : (
              <Globe2 aria-hidden="true" size={16} />
            )}
            <span>{label}</span>
            <OctantButton
              className="chip-x window-no-drag"
              type="button"
              variant="ghost"
              aria-label={`Remove ${label}`}
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
