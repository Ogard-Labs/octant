import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type RefObject,
} from "react";
import {
  acknowledgeWhatsNewOnce,
  acknowledgedWhatsNewVersion,
  subscribeWhatsNewAcknowledgement,
} from "./whatsNewAcknowledgement";
import { SIDEBAR_ACCOUNT_TRIGGER_SELECTOR } from "../shell/SidebarProfile";
import type {
  BundledWhatsNew,
  BundledWhatsNewAnnouncement,
  OctantHostBridge,
} from "../shell/hostBridge";

export interface WhatsNewCardContent {
  readonly version: string;
  readonly headline: string;
  readonly summary?: string;
}

/**
 * What a person sees after an update they chose finishes applying: one
 * announcement dialog when the release bundles one, otherwise a card in the
 * sidebar. Either one, once answered, acknowledges the notes for that update
 * and neither shows again. Answering never contacts a network.
 */
export interface WhatsNewController {
  /** Set while notes are due and the release bundles an announcement. */
  readonly announcement: BundledWhatsNewAnnouncement | undefined;
  /** Set while notes are due and there is no announcement. */
  readonly card: WhatsNewCardContent | undefined;
  readonly document: BundledWhatsNew | undefined;
  readonly notesOpen: boolean;
  /** Where a closing dialog returns focus: the sidebar profile row, when one is drawn. */
  readonly restoreFocus: RefObject<HTMLElement | null>;
  readonly closeNotes: () => void;
  /** Acknowledges the update's notes without opening them. */
  readonly dismiss: () => void;
  /** Acknowledges the update's notes and opens them. */
  readonly openNotes: () => void;
}

/**
 * The headline is the notes' first non-empty line; the summary is the next
 * paragraph. The notes stay plain text, so a build with a single paragraph
 * gets a card with a headline alone.
 */
export function whatsNewCardContent(version: string, text: string): WhatsNewCardContent {
  const lines = text.split("\n");
  const headlineIndex = lines.findIndex((line) => line.trim().length > 0);
  if (headlineIndex < 0) return { version, headline: "" };
  const headline = (lines[headlineIndex] ?? "").trim();
  const summary = lines
    .slice(headlineIndex + 1)
    .join("\n")
    .split(/\n\s*\n/)
    .map((block) =>
      block
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .join(" "),
    )
    .find((paragraph) => paragraph.length > 0);
  return { version, headline, ...(summary === undefined ? {} : { summary }) };
}

/**
 * Reads the bundled notes once, unless first-run setup is showing or there is
 * no desktop bridge. A browser or remote client has no bridge, so it never
 * asks and never shows either surface.
 */
export function useWhatsNewAfterUpdate(options: {
  readonly hostBridge?: OctantHostBridge | undefined;
  readonly firstRunVisible: boolean;
}): WhatsNewController {
  const read = options.hostBridge?.readBundledWhatsNew;
  const acknowledge = options.hostBridge?.acknowledgeWhatsNew;
  const [document, setDocument] = useState<BundledWhatsNew>();
  // Shared with Settings, which acknowledges the same update on its own.
  const acknowledgedVersion = useSyncExternalStore(
    subscribeWhatsNewAcknowledgement,
    acknowledgedWhatsNewVersion,
  );
  const [notesOpen, setNotesOpen] = useState(false);

  useEffect(() => {
    if (read === undefined || options.firstRunVisible) return;
    let cancelled = false;
    void read()
      .then((next) => {
        if (!cancelled) setDocument(next);
      })
      .catch(() => {
        if (!cancelled) setDocument({ kind: "empty", version: "", showAfterApply: false });
      });
    return () => {
      cancelled = true;
    };
  }, [options.firstRunVisible, read]);

  const restoreFocus = useRef<HTMLElement | null>(null);

  const dismiss = useCallback(() => {
    // Resolved at answer time: the sidebar may have been collapsed or opened
    // since the notes were read. Neither dialog has a trigger of its own.
    restoreFocus.current = globalThis.document.querySelector<HTMLElement>(
      SIDEBAR_ACCOUNT_TRIGGER_SELECTOR,
    );
    if (document !== undefined) {
      acknowledgeWhatsNewOnce(document.version, () => acknowledge?.());
    }
  }, [acknowledge, document]);
  const openNotes = useCallback(() => {
    setNotesOpen(true);
    dismiss();
  }, [dismiss]);
  const closeNotes = useCallback(() => setNotesOpen(false), []);

  const due =
    document?.kind === "notes" &&
    document.showAfterApply &&
    document.version !== acknowledgedVersion
      ? document
      : undefined;
  const card = useMemo(
    () =>
      due === undefined || due.announcement !== undefined
        ? undefined
        : whatsNewCardContent(due.version, due.text),
    [due],
  );
  // One controller until something in it changes. The sidebar takes it as a
  // prop, and a new object on every render of the app made the sidebar
  // commit on each streamed transcript event.
  return useMemo(
    () => ({
      announcement: due?.announcement,
      card,
      document,
      notesOpen,
      restoreFocus,
      closeNotes,
      dismiss,
      openNotes,
    }),
    [card, closeNotes, dismiss, document, due, notesOpen, openNotes],
  );
}
