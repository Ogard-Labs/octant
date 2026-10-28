import type { CanvasBlock, CanvasDeckBlock, CanvasMockupBlock } from "@octant/contracts/canvas";

import {
  CANVAS_MOCKUP_DEVICE_NAME,
  canvasMockupCallouts,
  canvasMockupFrames,
  type CanvasMockupFrame,
} from "@octant/domain";
import { useEffect, useRef, useState, type RefObject } from "react";
import { ChevronLeft, ChevronRight, Play } from "lucide-react";
import { OctantButton } from "../../ui/base/OctantButton";
import { OctantDialog } from "../../ui/base/OctantDialog";
import type { DesignAssetRuntime } from "./designDocument";
import { DesignFrameView, FullscreenButton, useFullscreen } from "./DesignBlock";
import { MockupFrame } from "./MockupBlock";
import { CanvasBlockRenderer } from "./CanvasBlock";

/**
 * A deck presents the document's own blocks as one ordered set of slides: a
 * design's frame or a mockup's screen at its own size, a data block as the
 * surface it already is. Present walks the slides across blocks — the design
 * player's anatomy, with the presenter's notes — and a plain design block
 * keeps its own Present unchanged.
 */

/** A mockup without variants names its single frame; a validated block holds one. */
const EMPTY_DECK_FRAME: CanvasMockupFrame = { key: "screen", label: undefined, roots: [] };

export function DeckBlock(props: {
  readonly block: CanvasDeckBlock;
  readonly blocks: ReadonlyArray<CanvasBlock>;
  readonly designAssetRuntime?: DesignAssetRuntime;
}) {
  const [presenting, setPresenting] = useState(false);
  const presentButton = useRef<HTMLButtonElement>(null);
  const byId = new Map(props.blocks.map((block) => [String(block.blockId), block]));
  const slides = props.block.slides.flatMap((slide) => {
    const block = byId.get(String(slide.blockId));
    return block === undefined ? [] : [{ slide, block }];
  });
  const notes = props.block.slides.some((slide) => slide.notes !== undefined);
  return (
    <section
      aria-label={`${props.block.title}, deck`}
      aria-roledescription="deck"
      className="canvas-deck"
      data-block-kind="deck"
    >
      <header className="canvas-deck__header">
        <h3 className="canvas-deck__title">{props.block.title}</h3>
        <span className="canvas-deck__meta">{`${String(slides.length)} slides`}</span>
        <OctantButton
          onClick={() => setPresenting(true)}
          ref={presentButton}
          size="sm"
          type="button"
          variant="secondary"
        >
          <Play aria-hidden="true" size={12} strokeWidth={2} />
          Present
        </OctantButton>
      </header>
      <ol className="canvas-deck__list">
        {slides.map(({ slide, block }, index) => (
          <li className="canvas-deck__slide" key={String(slide.slideId)}>
            <span className="canvas-deck__index">{String(index + 1)}</span>
            <span className="canvas-deck__label">
              {block.kind === "design" || block.kind === "mockup" ? block.title : block.kind}
            </span>
            {slide.notes === undefined ? null : (
              <span className="canvas-deck__notes">{slide.notes}</span>
            )}
          </li>
        ))}
      </ol>
      {presenting ? (
        <DeckPlayer
          block={props.block}
          slides={slides}
          {...(props.designAssetRuntime === undefined
            ? {}
            : { designAssetRuntime: props.designAssetRuntime })}
          hasNotes={notes}
          onClose={() => setPresenting(false)}
          restoreFocus={presentButton}
        />
      ) : null}
    </section>
  );
}

function DeckPlayer(props: {
  readonly block: CanvasDeckBlock;
  readonly slides: ReadonlyArray<{
    readonly slide: CanvasDeckBlock["slides"][number];
    readonly block: CanvasBlock;
  }>;
  readonly designAssetRuntime?: DesignAssetRuntime;
  readonly hasNotes: boolean;
  readonly onClose: () => void;
  readonly restoreFocus: RefObject<HTMLButtonElement | null>;
}) {
  const { slides } = props;
  const [index, setIndex] = useState(0);
  const [notesShown, setNotesShown] = useState(false);
  const fullscreen = useFullscreen<HTMLDivElement>();
  const last = slides.length - 1;
  const step = (by: number) => setIndex((value) => Math.min(last, Math.max(0, value + by)));
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "ArrowRight" || event.key === "PageDown") step(1);
      else if (event.key === "ArrowLeft" || event.key === "PageUp") step(-1);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  });
  const current = slides[index];
  const slide = current?.slide;
  const block = current?.block;
  const notes = slide?.notes;
  return (
    <OctantDialog
      className="canvas-deck-player"
      label={`Presenting ${props.block.title}`}
      onClose={props.onClose}
      open
      restoreFocus={props.restoreFocus}
    >
      <div className="canvas-deck-player__body" ref={fullscreen.ref}>
        <header className="canvas-deck-player__bar">
          <span className="canvas-deck-player__title">{props.block.title}</span>
          <span aria-live="polite" className="canvas-deck-player__position">
            {`${String(index + 1)} / ${String(last + 1)}`}
          </span>
          <div className="canvas-deck-player__actions">
            {props.hasNotes ? (
              <OctantButton
                aria-pressed={notesShown}
                onClick={() => setNotesShown((shown) => !shown)}
                size="sm"
                type="button"
                variant="ghost"
              >
                Notes
              </OctantButton>
            ) : null}
            <OctantButton
              aria-label="Previous slide"
              disabled={index === 0}
              onClick={() => step(-1)}
              size="icon-sm"
              type="button"
              variant="ghost"
            >
              <ChevronLeft aria-hidden="true" size={16} strokeWidth={1.8} />
            </OctantButton>
            <OctantButton
              aria-label="Next slide"
              disabled={index === last}
              onClick={() => step(1)}
              size="icon-sm"
              type="button"
              variant="ghost"
            >
              <ChevronRight aria-hidden="true" size={16} strokeWidth={1.8} />
            </OctantButton>
            <FullscreenButton fullscreen={fullscreen} />
          </div>
        </header>
        <div className="canvas-deck-player__stage">
          {block === undefined ? null : block.kind === "design" && slide?.frameId !== undefined ? (
            <DesignFrameView
              {...(props.designAssetRuntime === undefined
                ? {}
                : { assetRuntime: props.designAssetRuntime })}
              block={block}
              frameId={String(slide.frameId)}
              scale={0.6}
            />
          ) : block.kind === "mockup" ? (
            <div className="canvas-deck-player__mockup">
              <MockupFrame
                block={block as CanvasMockupBlock}
                callouts={canvasMockupCallouts(block as CanvasMockupBlock)}
                deviceDetail={
                  block.size === undefined
                    ? CANVAS_MOCKUP_DEVICE_NAME[block.device]
                    : `${String(block.size.width)} × ${String(block.size.height)}`
                }
                frame={canvasMockupFrames(block as CanvasMockupBlock)[0] ?? EMPTY_DECK_FRAME}
              />
            </div>
          ) : (
            <div className="canvas-deck-player__data">
              <CanvasBlockRenderer block={block} />
            </div>
          )}
          {notesShown && notes !== undefined ? (
            <p className="canvas-deck-player__notes">{notes}</p>
          ) : null}
        </div>
      </div>
    </OctantDialog>
  );
}
