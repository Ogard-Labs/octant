import { useCallback, useEffect, useState } from "react";
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
  const [answered, setAnswered] = useState(false);
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

  const dismiss = useCallback(() => {
    setAnswered(true);
    // Hiding it for this session is right even if the write fails: the person
    // answered, and a failed write only means it may show once more.
    void Promise.resolve(acknowledge?.()).catch(() => undefined);
  }, [acknowledge]);
  const openNotes = useCallback(() => {
    setNotesOpen(true);
    dismiss();
  }, [dismiss]);
  const closeNotes = useCallback(() => setNotesOpen(false), []);

  const due =
    document?.kind === "notes" && document.showAfterApply && !answered ? document : undefined;
  return {
    announcement: due?.announcement,
    card:
      due === undefined || due.announcement !== undefined
        ? undefined
        : whatsNewCardContent(due.version, due.text),
    document,
    notesOpen,
    closeNotes,
    dismiss,
    openNotes,
  };
}
