import { describe, expect, it } from "vitest";
import {
  NO_WRITTEN_DOCUMENTS,
  isDocumentPath,
  noteExistingDocuments,
  noteWrittenDocument,
} from "./writtenDocuments";

describe("documents an agent turn writes", () => {
  it("offers a written document once, and never again after the person closed it", () => {
    const handoff = { kind: "file" as const, path: "docs/handoff.md" };

    const first = noteWrittenDocument(NO_WRITTEN_DOCUMENTS, handoff);
    expect(first.open).toBe(true);
    expect(first.offers.current).toEqual(handoff);

    // The person closes the tab; the turn then rewrites the same file.
    const rewritten = noteWrittenDocument(first.offers, handoff);
    expect(rewritten.open).toBe(false);
    expect(rewritten.offers).toBe(first.offers);

    // A different document is new writing and opens on its own.
    const notes = { kind: "file" as const, path: "NOTES.txt" };
    const second = noteWrittenDocument(rewritten.offers, notes);
    expect(second.open).toBe(true);
    expect(second.offers.current).toEqual(notes);
  });

  it("does not offer the documents a thread already had when it was opened", () => {
    const existing = { kind: "canvas" as const, canvasId: "canvas-1" };
    const seeded = noteExistingDocuments(NO_WRITTEN_DOCUMENTS, [existing]);
    expect(seeded.current).toBeUndefined();
    expect(noteWrittenDocument(seeded, existing).open).toBe(false);

    const authored = { kind: "canvas" as const, canvasId: "canvas-2" };
    expect(noteWrittenDocument(seeded, authored).open).toBe(true);
  });

  it("treats Markdown and plain text as documents and everything else as code", () => {
    expect(isDocumentPath("docs/handoff.md")).toBe(true);
    expect(isDocumentPath("README.markdown")).toBe(true);
    expect(isDocumentPath("notes.TXT")).toBe(true);
    expect(isDocumentPath("src/index.ts")).toBe(false);
    expect(isDocumentPath(".md")).toBe(false);
    expect(isDocumentPath("Makefile")).toBe(false);
  });
});
