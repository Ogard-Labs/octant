import { useEffect, useMemo, useRef, useState } from "react";
import type { PreviewChunk, PreviewManifest } from "@octant/contracts/previews";
import { OctantButton } from "../ui/base/OctantButton";
import { PreviewFidelityNotice } from "./PreviewFidelityNotice";
import { buildPdfViewModel } from "./previewChunkModel";

/**
 * Read-only PDF preview viewer. Renders extracted per-page text with
 * page navigation, keyboard accessibility, and a visible fidelity notice
 * that the preview is text-only and active content is disabled. No
 * embedded JavaScript, forms, or external resources are executed.
 */
export function PdfViewer(props: {
  readonly manifest: PreviewManifest;
  readonly chunks: ReadonlyArray<PreviewChunk>;
}) {
  const model = useMemo(() => buildPdfViewModel(props.chunks), [props.chunks]);
  const pageCount = model.pages.length;
  const [page, setPage] = useState(1);
  const pageRef = useRef<HTMLDivElement>(null);
  const focusOnPageChange = useRef(false);

  useEffect(() => {
    if (page > pageCount) setPage(Math.max(1, pageCount));
  }, [page, pageCount]);

  useEffect(() => {
    if (!focusOnPageChange.current) return;
    focusOnPageChange.current = false;
    pageRef.current?.focus();
  }, [page]);

  if (pageCount === 0) {
    return (
      <section className="preview-viewer" aria-label="PDF preview">
        <PreviewFidelityNotice fidelity={props.manifest.fidelity} />
        <div className="preview-empty" role="status">
          No pages extracted.
        </div>
      </section>
    );
  }

  const currentPage = Math.min(page, pageCount);
  const pageText = model.pages[currentPage - 1] ?? "";
  const movePage = (delta: number) => {
    const nextPage = Math.min(pageCount, Math.max(1, currentPage + delta));
    if (nextPage === currentPage) return;
    focusOnPageChange.current = true;
    setPage(nextPage);
  };

  return (
    <section className="preview-viewer" aria-label="PDF preview">
      <PreviewFidelityNotice fidelity={props.manifest.fidelity} />
      <div className="preview-viewer__chrome">
        <h2 className="preview-viewer__title" title={props.manifest.target.displayName}>
          {props.manifest.target.displayName}
        </h2>
        <div className="preview-viewer__meta">
          <span>
            {currentPage} / {pageCount}
          </span>
        </div>
        <nav className="preview-nav" aria-label="PDF page navigation">
          <OctantButton
            aria-label="Previous page"
            className="preview-nav__button"
            disabled={currentPage <= 1}
            onClick={() => movePage(-1)}
            type="button"
            variant="ghost"
          >
            ‹
          </OctantButton>
          <span className="preview-nav__position" aria-live="polite">
            page {currentPage}
          </span>
          <OctantButton
            aria-label="Next page"
            className="preview-nav__button"
            disabled={currentPage >= pageCount}
            onClick={() => movePage(1)}
            type="button"
            variant="ghost"
          >
            ›
          </OctantButton>
        </nav>
      </div>
      <div className="preview-viewer__body">
        <div
          ref={pageRef}
          className="preview-pdf__page"
          tabIndex={0}
          role="document"
          aria-label={`Page ${currentPage} text`}
          aria-keyshortcuts="ArrowLeft ArrowRight ArrowUp ArrowDown"
          onKeyDown={(event) => {
            if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
              event.preventDefault();
              movePage(-1);
            } else if (event.key === "ArrowRight" || event.key === "ArrowDown") {
              event.preventDefault();
              movePage(1);
            }
          }}
        >
          <span className="preview-pdf__page-number">Page {currentPage}</span>
          {pageText.length > 0 ? (
            pageText
          ) : (
            <span className="preview-pdf__page--empty">No extractable text on this page.</span>
          )}
        </div>
      </div>
    </section>
  );
}
