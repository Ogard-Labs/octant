import type { CanvasBlock, CanvasDiffLine } from "@octant/contracts/canvas";

type Block = Extract<CanvasBlock, { readonly kind: "code-excerpt" | "pseudocode" | "diff" }>;

const diffPrefix: Record<CanvasDiffLine["kind"], string> = {
  add: "+",
  remove: "-",
  context: " ",
};

const diffAriaLabel: Record<CanvasDiffLine["kind"], string> = {
  add: "added line",
  remove: "removed line",
  context: "context line",
};

export function CodeBlocks({ block }: { readonly block: Block }) {
  switch (block.kind) {
    case "code-excerpt":
      return (
        <section className="canvas-block__code">
          <div className="canvas-block__code-head">
            <span>{block.language}</span>
            {block.startLine !== undefined && block.endLine !== undefined ? (
              <span>
                lines {block.startLine}–{block.endLine}
              </span>
            ) : null}
          </div>
          <pre>
            <code>{block.code}</code>
          </pre>
        </section>
      );
    case "pseudocode":
      return (
        <div className="canvas-block__pseudocode">
          <pre>
            <code>{block.code}</code>
          </pre>
        </div>
      );
    case "diff":
      return (
        <div className="canvas-block__diff">
          {block.hunks.map((hunk, hunkIndex) => (
            <div key={hunkIndex} className="canvas-block__diff-hunk">
              <div className="canvas-block__diff-header">{hunk.header}</div>
              <pre>
                <code>
                  {hunk.lines.map((line, lineIndex) => (
                    <span
                      key={lineIndex}
                      aria-label={diffAriaLabel[line.kind]}
                      className={`canvas-block__diff-line canvas-block__diff-line--${line.kind}`}
                    >
                      {diffPrefix[line.kind]}
                      {line.text}
                    </span>
                  ))}
                </code>
              </pre>
            </div>
          ))}
        </div>
      );
  }
}
