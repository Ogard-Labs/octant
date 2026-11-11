import { Info } from "lucide-react";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantTooltip } from "../ui/base/OctantTooltip";

interface ThreadInfoPanel {
  /** Opens the panel, for a control elsewhere that leads to one of its rows. */
  readonly open: () => void;
  /** Marks the panel's button while a row needs the person. */
  readonly flag: (key: string, needsPerson: boolean) => void;
}

/** Popups a row opens. They are drawn outside the panel but belong to it. */
const ROW_POPUP = '[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"]';

const ThreadInfoContext = createContext<ThreadInfoPanel | undefined>(undefined);

/** The thread's info panel, or undefined where a row renders outside one. */
export function useThreadInfoPanel(): ThreadInfoPanel | undefined {
  return useContext(ThreadInfoContext);
}

/**
 * Marks the panel's button while this row waits on the person. A row inside a
 * closed panel is out of sight, so a pending review must show on the button.
 */
export function useThreadInfoAttention(key: string, needsPerson: boolean): void {
  const panel = useContext(ThreadInfoContext);
  useEffect(() => {
    if (panel === undefined) return undefined;
    panel.flag(key, needsPerson);
    return () => panel.flag(key, false);
  }, [panel, key, needsPerson]);
}

/**
 * One home for what is true about a thread but is not part of the
 * conversation: its access level and where that came from, credential
 * commands, provider cloud sessions, and continuing elsewhere. Each of those
 * had been added to the thread page on its own, so they sat at four different
 * places and two of them outside the reading column.
 *
 * The rows stay mounted while the panel is closed: they read host state and
 * one of them holds a review, which must not restart each time the panel
 * opens.
 */
export function ThreadInfo(props: { readonly children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [flags, setFlags] = useState<ReadonlySet<string>>(() => new Set());
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const panelId = useId();
  const flag = useCallback((key: string, needsPerson: boolean) => {
    setFlags((current) => {
      if (current.has(key) === needsPerson) return current;
      const next = new Set(current);
      if (needsPerson) next.add(key);
      else next.delete(key);
      return next;
    });
  }, []);
  const panel = useMemo<ThreadInfoPanel>(() => ({ open: () => setOpen(true), flag }), [flag]);

  useEffect(() => {
    if (!open) return undefined;
    const closeOnOutsidePress = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Element) || root.current?.contains(target) === true) return;
      // A dialog or menu a row opened is drawn outside the panel but belongs
      // to it; pressing inside one must not close the panel under it.
      if (target.closest(ROW_POPUP)) return;
      setOpen(false);
    };
    document.addEventListener("pointerdown", closeOnOutsidePress);
    return () => document.removeEventListener("pointerdown", closeOnOutsidePress);
  }, [open]);

  return (
    <ThreadInfoContext.Provider value={panel}>
      <div
        className="thread-info"
        onKeyDown={(event) => {
          if (event.key !== "Escape" || !open) return;
          // Escape in a row's own menu or dialog closes that, not the panel:
          // React hands the key to this wrapper even from a portaled popup.
          if (event.target instanceof Element && event.target.closest(ROW_POPUP)) return;
          event.stopPropagation();
          setOpen(false);
          trigger.current?.focus();
        }}
        ref={root}
      >
        {/* The button is its icon alone: its two words made the line under
            the card wrap in a split pane, and left the trailing control on a
            line of its own. A waiting review still says so in words. */}
        <OctantTooltip align="end" label="Thread info" side="top">
          <OctantButton
            aria-controls={panelId}
            aria-expanded={open}
            aria-label={flags.size === 0 ? "Thread info" : "Thread info, review required"}
            className="thread-info__trigger"
            onClick={() => setOpen((value) => !value)}
            ref={trigger}
            size={flags.size === 0 ? "icon" : "sm"}
            type="button"
            variant="ghost"
          >
            <Info aria-hidden="true" size={14} strokeWidth={1.8} />
            {flags.size === 0 ? null : (
              <span className="thread-info__attention">Review required</span>
            )}
          </OctantButton>
        </OctantTooltip>
        <section
          aria-label="Thread info"
          className="thread-info__panel"
          hidden={!open}
          id={panelId}
        >
          {props.children}
        </section>
      </div>
    </ThreadInfoContext.Provider>
  );
}
