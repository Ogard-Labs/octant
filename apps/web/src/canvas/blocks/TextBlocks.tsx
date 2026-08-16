import type { CanvasBlock } from "@octant/contracts/canvas";
import { createElement } from "react";
import { isSafeLinkHref } from "../canvasRuntime";

type Block = Extract<
  CanvasBlock,
  { readonly kind: "heading" | "rich-text" | "callout" | "link" | "divider" | "citation" }
>;

const headingLevel = (level: number): 1 | 2 | 3 | 4 | 5 | 6 => {
  if (level >= 1 && level <= 6) return level as 1 | 2 | 3 | 4 | 5 | 6;
  return 2;
};

export function TextBlocks({ block }: { readonly block: Block }) {
  switch (block.kind) {
    case "heading":
      return createElement(
        `h${headingLevel(block.level)}`,
        { className: "canvas-block__heading", "aria-level": block.level },
        block.text,
      );
    case "rich-text":
      return <p className="canvas-block__rich-text">{block.text}</p>;
    case "callout":
      return (
        <aside role="note" className={`canvas-block__callout canvas-block__callout--${block.tone}`}>
          {block.title !== undefined ? (
            <strong className="canvas-block__callout-title">{block.title}</strong>
          ) : null}
          <p>{block.text}</p>
        </aside>
      );
    case "link":
      return isSafeLinkHref(block.href) ? (
        <a
          className="canvas-block__link"
          href={block.href}
          target="_blank"
          rel="noopener noreferrer"
        >
          {block.label}
        </a>
      ) : (
        <span className="canvas-block__link--unsafe">{block.label}</span>
      );
    case "divider":
      return <hr className="canvas-block__divider" />;
    case "citation":
      return (
        <figure className="canvas-block__citation">
          <blockquote>{block.quote}</blockquote>
          <figcaption>{block.label}</figcaption>
        </figure>
      );
  }
}
