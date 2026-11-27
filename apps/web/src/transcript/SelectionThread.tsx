import type { ResultQuoteSource } from "../composer/resultQuoteDraft";
import { followSelectionWithin } from "./selectionOwner";
import type { ProjectId } from "@octant/contracts/projects";
import { MessageSquarePlus } from "../ui/icons";
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

/** What a selection in a reply can do here, in the order offered. */
type SelectionAction = {
  readonly label: string;
  readonly run: (text: string, source?: ResultQuoteSource) => void;
};
const QuoteSelectionContext = createContext<ReadonlyArray<SelectionAction>>([]);

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
  /** Adds selected reply text to this thread's own composer as a quote chip. */
  readonly onAddToChat?: ((text: string, source?: ResultQuoteSource) => void) | undefined;
  readonly children: ReactNode;
}) {
  const start = useContext(SelectionThreadStarterContext);
  const { mode, projectId, onAddToChat } = props;
  const quote = useMemo(
    () => [
      ...(onAddToChat === undefined ? [] : [{ label: "Add to chat", run: onAddToChat }]),
      ...(start === undefined || projectId === undefined
        ? []
        : [
            {
              label: "New thread from selection",
              run: (text: string) =>
                start({ mode, projectId, prompt: selectionAsBlockQuote(text) }),
            },
          ]),
    ],
    [mode, projectId, start, onAddToChat],
  );
  return (
    <QuoteSelectionContext.Provider value={quote}>{props.children}</QuoteSelectionContext.Provider>
  );
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

/**
 * Wraps one assistant reply. Selecting text in it offers "Add to chat" (a quote
 * chip in this thread's composer) and "New thread from selection" as small
 * actions under the reply and in the right-click menu.
 */
export function SelectionThreadSurface(props: {
  readonly children: ReactNode;
  readonly resultSource?: ResultQuoteSource;
  readonly onResultQuote?: ((text: string, source: ResultQuoteSource) => void) | undefined;
}) {
  const actions = useContext(QuoteSelectionContext);
  const { resultSource, onResultQuote } = props;
  const addToChat = onResultQuote ?? actions.find((action) => action.label === "Add to chat")?.run;
  const quote =
    resultSource === undefined
      ? actions
      : addToChat === undefined
        ? []
        : [{ label: "Add to chat", run: (text: string) => addToChat(text, resultSource) }];
  const containerRef = useRef<HTMLDivElement>(null);
  const offerRef = useRef<HTMLDivElement>(null);
  const [offer, setOffer] = useState("");
  const [menuText, setMenuText] = useState("");
  const enabled = quote.length > 0;

  useEffect(() => {
    if (!enabled) return;
    return followSelectionWithin(
      () => containerRef.current,
      (text) => {
        // Moving keyboard focus to an action can collapse the document selection.
        if (text === "" && offerRef.current?.contains(document.activeElement) === true) return;
        setOffer(text);
      },
    );
  }, [enabled]);

  const start = useCallback((text: string, action: SelectionAction | undefined) => {
    if (text === "") return;
    action?.run(text);
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
        items={quote.map(({ label }) => ({
          value: label,
          label,
          icon: <MessageSquarePlus size={14} />,
          disabled: menuText === "",
        }))}
        onValueChange={(value) =>
          start(
            menuText,
            quote.find((action) => action.label === value),
          )
        }
      >
        {props.children}
      </OctantContextMenu>
      {offer === "" ? null : (
        <div
          className="transcript-selection-thread__offer"
          onBlur={(event) => {
            if (
              !event.currentTarget.contains(event.relatedTarget) &&
              selectionWithin(containerRef.current) === ""
            ) {
              setOffer("");
            }
          }}
          ref={offerRef}
        >
          {quote.map((action) => (
            <OctantButton
              key={action.label}
              onClick={(event: ReactMouseEvent<HTMLButtonElement>) => {
                event.preventDefault();
                start(offer, action);
              }}
              onMouseDown={(event) => {
                // Keep the selection until click runs; mouse-down would clear it.
                event.preventDefault();
              }}
              size="sm"
              type="button"
              variant="secondary"
            >
              {action.label}
            </OctantButton>
          ))}
        </div>
      )}
    </div>
  );
}
