import type { ProjectId } from "@octant/contracts/projects";
import { MessageSquarePlus } from "lucide-react";
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
  readonly children: ReactNode;
}) {
  const start = useContext(SelectionThreadStarterContext);
  const { mode, projectId } = props;
  const quote = useMemo(
    () =>
      start === undefined || projectId === undefined
        ? undefined
        : (text: string) => start({ mode, projectId, prompt: selectionAsBlockQuote(text) }),
    [mode, projectId, start],
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

const MENU_VALUE = "new-thread-from-selection";

/**
 * Wraps one assistant reply. Selecting text in it offers "New thread from
 * selection" as a small action under the reply and in the right-click menu.
 */
export function SelectionThreadSurface(props: { readonly children: ReactNode }) {
  const quote = useContext(QuoteSelectionContext);
  const containerRef = useRef<HTMLDivElement>(null);
  const [offer, setOffer] = useState("");
  const [menuText, setMenuText] = useState("");
  const enabled = quote !== undefined;

  useEffect(() => {
    if (!enabled) return;
    const onSelectionChange = () => setOffer(selectionWithin(containerRef.current));
    document.addEventListener("selectionchange", onSelectionChange);
    return () => document.removeEventListener("selectionchange", onSelectionChange);
  }, [enabled]);

  const start = useCallback(
    (text: string) => {
      if (text === "") return;
      quote?.(text);
      setOffer("");
      document.getSelection()?.removeAllRanges();
    },
    [quote],
  );

  if (!enabled) return <>{props.children}</>;
  return (
    <div
      className="transcript-selection-thread"
      onContextMenuCapture={() => setMenuText(selectionWithin(containerRef.current))}
      ref={containerRef}
    >
      <OctantContextMenu
        items={[
          {
            value: MENU_VALUE,
            label: "New thread from selection",
            icon: <MessageSquarePlus size={14} />,
            disabled: menuText === "",
          },
        ]}
        onValueChange={() => start(menuText)}
      >
        {props.children}
      </OctantContextMenu>
      {offer === "" ? null : (
        <div className="transcript-selection-thread__offer">
          <OctantButton
            onClick={(event: ReactMouseEvent<HTMLButtonElement>) => {
              event.preventDefault();
              start(offer);
            }}
            onMouseDown={(event) => {
              // Keep the selection until click runs; mouse-down would clear it.
              event.preventDefault();
            }}
            size="sm"
            type="button"
            variant="secondary"
          >
            New thread from selection
          </OctantButton>
        </div>
      )}
    </div>
  );
}
