/**
 * Documents an agent turn wrote for a thread, and which of them the dock has
 * already shown.
 *
 * A thread's provider reports a Markdown or text file it created or rewrote
 * as an ordinary file change, and a Canvas it authored as a reference card.
 * Both are documents a person reads rather than code they review, so the dock
 * offers each one beside the transcript the first time it appears. The offer
 * is made once per document: a rewrite, or a document the person already
 * closed, never reopens the tab, and a document the thread already had when
 * it was opened is what the person has seen, not new writing.
 */
export type WrittenDocument =
  | { readonly kind: "file"; readonly path: string }
  | { readonly kind: "canvas"; readonly canvasId: string };

export interface WrittenDocumentOffers {
  readonly offered: ReadonlySet<string>;
  /** The document the dock shows for this thread, when one was written. */
  readonly current?: WrittenDocument;
}

export const NO_WRITTEN_DOCUMENTS: WrittenDocumentOffers = { offered: new Set() };

const DOCUMENT_EXTENSIONS: ReadonlySet<string> = new Set(["md", "markdown", "mdx", "txt"]);

/** Whether a written path is a document to read rather than code to review. */
export function isDocumentPath(path: string): boolean {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return false;
  return DOCUMENT_EXTENSIONS.has(name.slice(dot + 1).toLowerCase());
}

export function writtenDocumentId(document: WrittenDocument): string {
  return document.kind === "file" ? `file:${document.path}` : `canvas:${document.canvasId}`;
}

/**
 * Notes one document a turn wrote. `open` is true exactly once per document:
 * the first time it is written, never for a rewrite, and never after the
 * person closed the tab that showed it.
 */
export function noteWrittenDocument(
  offers: WrittenDocumentOffers,
  document: WrittenDocument,
): { readonly offers: WrittenDocumentOffers; readonly open: boolean } {
  const id = writtenDocumentId(document);
  if (offers.offered.has(id)) return { offers, open: false };
  const offered = new Set(offers.offered);
  offered.add(id);
  return { offers: { offered, current: document }, open: true };
}

/**
 * Notes the documents a thread already had when it was opened. They stay
 * reachable from the dock's tool list but are not offered: the person has
 * seen them, and reopening an old thread must not raise the dock.
 */
export function noteExistingDocuments(
  offers: WrittenDocumentOffers,
  documents: ReadonlyArray<WrittenDocument>,
): WrittenDocumentOffers {
  if (documents.length === 0) return offers;
  const offered = new Set(offers.offered);
  for (const document of documents) offered.add(writtenDocumentId(document));
  return { ...offers, offered };
}

/**
 * Drops the shown document when the turn deleted the file behind it.
 *
 * A turn can write a document and then remove it, which takes the path out of
 * the turn's written paths. The dock must stop offering a file that is no
 * longer there rather than hand the Document tool a path that cannot be read.
 *
 * The rule reads the move from written to gone, not absence alone: a reopened
 * thread replays tool and reasoning steps without written paths, and that
 * person has not lost a document. The document stays in `offered`, so a
 * rewrite still does not reopen the tab.
 */
export function forgetDeletedWrittenDocument(
  offers: WrittenDocumentOffers,
  previousPaths: ReadonlySet<string>,
  livePaths: ReadonlySet<string>,
): WrittenDocumentOffers {
  const current = offers.current;
  if (current === undefined || current.kind !== "file") return offers;
  if (!previousPaths.has(current.path) || livePaths.has(current.path)) return offers;
  return { offered: offers.offered };
}
