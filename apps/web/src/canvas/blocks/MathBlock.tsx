import { useLayoutEffect, useRef, useState } from "react";
import katex from "katex";
// KaTeX's stylesheet and fonts are bundled with the renderer: the page's font
// policy loads fonts from its own origin only, and a formula must draw offline.
import "katex/dist/katex.min.css";
import type {
  CanvasMathBlock,
  CanvasMathDisplayBlock,
  CanvasMathInlineBlock,
} from "@octant/contracts/canvas";
import { canvasMathRenderOptions } from "@octant/domain/canvas-math-policy";

/**
 * Math drawn from a TeX-like source, never run.
 *
 * KaTeX builds the formula as DOM nodes into an element React leaves empty, so
 * no markup string is ever parsed into the page. Its output pairs the drawn
 * glyphs (hidden from assistive technology) with MathML carrying the source as
 * an annotation, so a screen reader reads the mathematics rather than the
 * glyph soup. The source is also offered as plain text under View source, and
 * a formula KaTeX refuses is shown as its source with a plain note instead of
 * KaTeX's coloured error text, which would not survive a dark theme or forced
 * colours.
 */
export function MathBlock({ block }: { readonly block: CanvasMathBlock }) {
  return block.layout === "display" ? <DisplayMath block={block} /> : <InlineMath block={block} />;
}

function DisplayMath({ block }: { readonly block: CanvasMathDisplayBlock }) {
  return (
    <figure className="canvas-block__math">
      {/* A long formula scrolls inside its own region, so the page does not
          scroll sideways at phone width and a keyboard can still reach it. */}
      <div
        aria-label={block.caption ?? "Formula"}
        className="canvas-block__math-display"
        role="region"
        tabIndex={0}
      >
        <Formula display source={block.source} />
      </div>
      {block.caption === undefined ? null : (
        <figcaption className="canvas-block__math-caption">{block.caption}</figcaption>
      )}
      <details className="canvas-block__math-source">
        <summary>View source</summary>
        <pre>
          <code>{block.source}</code>
        </pre>
      </details>
    </figure>
  );
}

function InlineMath({ block }: { readonly block: CanvasMathInlineBlock }) {
  return (
    <div className="canvas-block__math">
      <p className="canvas-block__math-paragraph">
        {block.runs.map((run, index) =>
          "math" in run ? (
            <Formula display={false} key={index} source={run.math} />
          ) : (
            <span key={index}>{run.text}</span>
          ),
        )}
      </p>
      <details className="canvas-block__math-source">
        <summary>View source</summary>
        <p>
          {block.runs.map((run, index) =>
            "math" in run ? (
              <code key={index}>{run.math}</code>
            ) : (
              <span key={index}>{run.text}</span>
            ),
          )}
        </p>
      </details>
    </div>
  );
}

function Formula({ source, display }: { readonly source: string; readonly display: boolean }) {
  const target = useRef<HTMLSpanElement>(null);
  const [refused, setRefused] = useState<{ readonly source: string } | undefined>(undefined);

  useLayoutEffect(() => {
    const element = target.current;
    if (element === null) return;
    try {
      katex.render(source, element, canvasMathRenderOptions(display, "htmlAndMathml"));
      setRefused(undefined);
    } catch {
      // KaTeX throws a ParseError for markup it will not draw under strict
      // mode, including anything that would need trust. The reason names
      // TeX internals, so the reader is shown the source instead.
      element.replaceChildren();
      setRefused({ source });
    }
  }, [source, display]);

  const failed = refused !== undefined && refused.source === source;
  return (
    <>
      <span
        className={display ? "canvas-block__math-formula is-display" : "canvas-block__math-formula"}
        hidden={failed}
        ref={target}
      />
      {failed ? (
        <span className="canvas-block__math-refused" role="note">
          <code>{source}</code>
          <span className="canvas-block__math-refused-note">This formula could not be drawn.</span>
        </span>
      ) : null}
    </>
  );
}
