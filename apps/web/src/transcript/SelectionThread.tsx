import { followSelectionWithin } from "./selectionOwner";
import type { ProjectId } from "@octant/contracts/projects";
import { MessageSquarePlus, Quote } from "../ui/icons";
import { REPLY_QUOTE_SOURCE, type ComposerQuote } from "../composer/composerQuote";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantContextMenu } from "../ui/base/OctantContextMenu";

export interface SelectionThreadRequest {
  readonly mode: "work" | "code";
  readonly projectId: ProjectId;
  readonly prompt: string;
}

/**
 * Supplied by the app shell. It opens a clean draft in the Project; it never
 * starts a turn, so the new thread has the authority any new thread there has.
 */
export const SelectionThreadStarterContext = createContext<
  ((request: SelectionThreadRequest) => void) | undefined
>(undefined);

const QuoteSelectionContext = createContext<((text: string) => void) | undefined>(undefined);
const AddToChatContext = createContext<((text: string) => void) | undefined>(undefined);

/** Selected prose as a Markdown block quote, ready for a composer to continue under. */
export function selectionAsBlockQuote(text: string): string {
  const lines = text.trim().split(/\r?\n/);
  return `${lines.map((line) => (line === "" ? ">" : `> ${line}`)).join("\n")}\n\n`;
}

/**
 * Marks a thread's transcript as one that can start a new thread in its own
 * Project and mode. Outside this scope (or without a shell starter) replies
 * offer nothing.
 */
export function SelectionThreadScope(props: {
  readonly mode: "work" | "code";
  readonly projectId: ProjectId | undefined;
  /** Adds a selection to this thread's own composer as a quote chip. */
  readonly onAddToChat?: ((quote: ComposerQuote) => void) | undefined;
  readonly children: ReactNode;
}) {
  const start = useContext(SelectionThreadStarterContext);
  const { mode, projectId, onAddToChat } = props;
  const quote = useMemo(
    () =>
      start === undefined || projectId === undefined
        ? undefined
        : (text: string) => start({ mode, projectId, prompt: selectionAsBlockQuote(text) }),
    [mode, projectId, start],
  );
  const addToChat = useMemo(
    () =>
      onAddToChat === undefined
        ? undefined
        : (text: string) => onAddToChat({ source: REPLY_QUOTE_SOURCE, text, comment: "" }),
    [onAddToChat],
  );
  return (
    <QuoteSelectionContext.Provider value={quote}>
      <AddToChatContext.Provider value={addToChat}>{props.children}</AddToChatContext.Provider>
    </QuoteSelectionContext.Provider>
  );
}

// Keep the selection until click runs; mouse-down would clear it.
function keepSelection(event: ReactMouseEvent<HTMLButtonElement>): void {
  event.preventDefault();
}

function selectionWithin(container: HTMLElement | null): string {
  if (container === null) return "";
  const selection = document.getSelection();
  if (selection === null || selection.isCollapsed || selection.rangeCount === 0) return "";
  const { anchorNode, focusNode } = selection;
  if (anchorNode === null || focusNode === null) return "";
  if (!container.contains(anchorNode) || !container.contains(focusNode)) return "";
  return selection.toString().trim();
}

const MENU_VALUE = "new-thread-from-selection";
const ADD_TO_CHAT_VALUE = "add-to-chat";

/**
 * Wraps one assistant reply. Selecting text in it offers "Add to chat" (a quote
 * chip in this thread's composer) and "New thread from selection" as small
 * actions under the reply and in the right-click menu.
 */
export function SelectionThreadSurface(props: { readonly children: ReactNode }) {
  const quote = useContext(QuoteSelectionContext);
  const addToChat = useContext(AddToChatContext);
  const containerRef = useRef<HTMLDivElement>(null);
  const [offer, setOffer] = useState("");
  const [menuText, setMenuText] = useState("");
  const enabled = quote !== undefined || addToChat !== undefined;

  useEffect(() => {
    if (!enabled) return;
    return followSelectionWithin(() => containerRef.current, setOffer);
  }, [enabled]);

  const act = useCallback((text: string, action: ((text: string) => void) | undefined) => {
    if (text === "") return;
    action?.(text);
    setOffer("");
    document.getSelection()?.removeAllRanges();
  }, []);

  if (!enabled) return <>{props.children}</>;
  return (
    <div
      className="transcript-selection-thread"
      onContextMenuCapture={() => setMenuText(selectionWithin(containerRef.current))}
      ref={containerRef}
    >
      <OctantContextMenu
        items={[
          ...(addToChat === undefined
            ? []
            : [
                {
                  value: ADD_TO_CHAT_VALUE,
                  label: "Add to chat",
                  icon: <Quote size={14} />,
                  disabled: menuText === "",
                },
              ]),
          ...(quote === undefined
            ? []
            : [
                {
                  value: MENU_VALUE,
                  label: "New thread from selection",
                  icon: <MessageSquarePlus size={14} />,
                  disabled: menuText === "",
                },
              ]),
        ]}
        onValueChange={(value) => act(menuText, value === ADD_TO_CHAT_VALUE ? addToChat : quote)}
      >
        {props.children}
      </OctantContextMenu>
      {offer === "" ? null : (
        <div className="transcript-selection-thread__offer">
          {addToChat === undefined ? null : (
            <OctantButton
              onClick={(event: ReactMouseEvent<HTMLButtonElement>) => {
                event.preventDefault();
                act(offer, addToChat);
              }}
              onMouseDown={keepSelection}
              size="sm"
              type="button"
              variant="secondary"
            >
              Add to chat
            </OctantButton>
          )}
          {quote === undefined ? null : (
            <OctantButton
              onClick={(event: ReactMouseEvent<HTMLButtonElement>) => {
                event.preventDefault();
                act(offer, quote);
              }}
              onMouseDown={keepSelection}
              size="sm"
              type="button"
              variant="secondary"
            >
              New thread from selection
            </OctantButton>
          )}
        </div>
      )}
    </div>
  );
}
