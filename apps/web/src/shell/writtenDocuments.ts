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
  | {
      readonly kind: "canvas";
      readonly canvasId: string;
      /** The Canvas's own title, when the window read its card. */
      readonly title?: string;
    };

export interface WrittenDocumentOffers {
  readonly offered: ReadonlySet<string>;
  /** The document the dock shows for this thread, when one was written. */
  readonly current?: WrittenDocument;
  /**
   * Every document the window knows the thread has, oldest first: the ones it
   * had when it was opened and the ones its turns wrote since. The dock's
   * overview lists them as the thread's outputs.
   */
  readonly documents: ReadonlyArray<WrittenDocument>;
}

export const NO_WRITTEN_DOCUMENTS: WrittenDocumentOffers = { offered: new Set(), documents: [] };

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
  if (offers.offered.has(id)) {
    // A document deleted and later recreated stays offered, so it never
    // reopens the tab, but it is a live output again and belongs in the list.
    const documents = withDocument(offers.documents, document);
    if (documents === offers.documents) return { offers, open: false };
    return { offers: { ...offers, documents }, open: false };
  }
  const offered = new Set(offers.offered);
  offered.add(id);
  return {
    offers: { offered, current: document, documents: withDocument(offers.documents, document) },
    open: true,
  };
}

/**
 * Shows a document the person asked to see, such as a Canvas drawn in the
 * thread they chose to open beside it. A person's request is not a turn's
 * offer, so it opens even a document that was offered or closed before.
 */
export function showWrittenDocument(
  offers: WrittenDocumentOffers,
  document: WrittenDocument,
): WrittenDocumentOffers {
  const offered = new Set(offers.offered);
  offered.add(writtenDocumentId(document));
  return { offered, current: document, documents: withDocument(offers.documents, document) };
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
  let known = offers.documents;
  for (const document of documents) {
    offered.add(writtenDocumentId(document));
    known = withDocument(known, document);
  }
  return { ...offers, offered, documents: known };
}

/**
 * Drops a document the turn deleted, and stops showing it.
 *
 * A turn can write a document and then remove it, which takes the path out of
 * the turn's written paths. The dock must stop offering a file that is no
 * longer there rather than hand the Document tool a path that cannot be read,
 * and must stop listing it among the thread's outputs.
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
  const deleted = (document: WrittenDocument) =>
    document.kind === "file" && previousPaths.has(document.path) && !livePaths.has(document.path);
  const documents = offers.documents.filter((document) => !deleted(document));
  const current = offers.current;
  const currentDeleted = current !== undefined && deleted(current);
  if (!currentDeleted && documents.length === offers.documents.length) return offers;
  return {
    offered: offers.offered,
    documents,
    ...(current === undefined || currentDeleted ? {} : { current }),
  };
}

/** Adds a document once; a later sighting with a title names the one already listed. */
function withDocument(
  documents: ReadonlyArray<WrittenDocument>,
  document: WrittenDocument,
): ReadonlyArray<WrittenDocument> {
  const id = writtenDocumentId(document);
  const index = documents.findIndex((known) => writtenDocumentId(known) === id);
  if (index === -1) return [...documents, document];
  const known = documents[index];
  if (document.kind !== "canvas" || document.title === undefined) return documents;
  if (known?.kind === "canvas" && known.title === document.title) return documents;
  return documents.map((entry, at) => (at === index ? document : entry));
}
