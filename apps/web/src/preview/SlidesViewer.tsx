import { useEffect, useMemo, useRef, useState } from "react";
import type { PreviewChunk, PreviewManifest } from "@octant/contracts/previews";
import { OctantButton } from "../ui/base/OctantButton";
import { PreviewFidelityNotice } from "./PreviewFidelityNotice";
import { buildSlidesViewModel } from "./previewChunkModel";

/**
 * Read-only PPTX preview viewer. Renders slide text (title + body
 * bullets) with slide navigation and keyboard accessibility.
 * Transitions, media playback, embedded objects, and pixel-perfect
 * layout are not preserved; the fidelity notice surfaces the limitation.
 */
export function SlidesViewer(props: {
  readonly manifest: PreviewManifest;
  readonly chunks: ReadonlyArray<PreviewChunk>;
}) {
  const model = useMemo(() => buildSlidesViewModel(props.chunks), [props.chunks]);
  const slideCount = model.slides.length;
  const [slide, setSlide] = useState(1);
  const slideRef = useRef<HTMLDivElement>(null);
  const focusOnSlideChange = useRef(false);

  useEffect(() => {
    if (!focusOnSlideChange.current) return;
    focusOnSlideChange.current = false;
    slideRef.current?.focus();
  }, [slide]);

  useEffect(() => {
    if (slide > slideCount) setSlide(Math.max(1, slideCount));
  }, [slide, slideCount]);

  if (slideCount === 0) {
    return (
      <section className="preview-viewer" aria-label="Slides preview">
        <PreviewFidelityNotice fidelity={props.manifest.fidelity} />
        <div className="preview-empty" role="status">
          No slides decoded.
        </div>
      </section>
    );
  }

  const current = Math.min(slide, slideCount);
  const slideText = model.slides[current - 1] ?? "";
  const [title, ...bodyLines] = slideText.split("\n");
  const body = bodyLines.join("\n").trim();
  const moveSlide = (delta: number) => {
    const nextSlide = Math.min(slideCount, Math.max(1, current + delta));
    if (nextSlide === current) return;
    focusOnSlideChange.current = true;
    setSlide(nextSlide);
  };

  return (
    <section className="preview-viewer" aria-label="Slides preview">
      <PreviewFidelityNotice fidelity={props.manifest.fidelity} />
      <div className="preview-viewer__chrome">
        <h2 className="preview-viewer__title" title={props.manifest.target.displayName}>
          {props.manifest.target.displayName}
        </h2>
        <div className="preview-viewer__meta">
          <span>
            {current} / {slideCount}
          </span>
        </div>
        <nav className="preview-nav" aria-label="Slide navigation">
          <OctantButton
            className="preview-nav__button"
            type="button"
            disabled={current <= 1}
            onClick={() => moveSlide(-1)}
            aria-label="Previous slide"
            variant="ghost"
            size="icon"
          >
            ‹
          </OctantButton>
          <span className="preview-nav__position" aria-live="polite">
            slide {current}
          </span>
          <OctantButton
            className="preview-nav__button"
            type="button"
            disabled={current >= slideCount}
            onClick={() => moveSlide(1)}
            aria-label="Next slide"
            variant="ghost"
            size="icon"
          >
            ›
          </OctantButton>
        </nav>
      </div>
      <div className="preview-viewer__body">
        <div className="preview-slides">
          <div
            ref={slideRef}
            className="preview-slides__slide"
            role="document"
            aria-label={`Slide ${current} text`}
            tabIndex={0}
            aria-keyshortcuts="ArrowLeft ArrowRight ArrowUp ArrowDown"
            onKeyDown={(event) => {
              if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
                event.preventDefault();
                moveSlide(-1);
              } else if (event.key === "ArrowRight" || event.key === "ArrowDown") {
                event.preventDefault();
                moveSlide(1);
              }
            }}
          >
            <h3 className="preview-slides__slide-title">
              {title && title.length > 0 ? (
                title
              ) : (
                <span className="preview-pdf__page--empty">Untitled slide</span>
              )}
            </h3>
            <p className="preview-slides__slide-body">
              {body.length > 0 ? (
                body
              ) : (
                <span className="preview-pdf__page--empty">No body text.</span>
              )}
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}
