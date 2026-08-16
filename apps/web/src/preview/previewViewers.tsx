import type { ReactNode } from "react";
import type { PreviewChunk, PreviewKind } from "@octant/contracts/previews";

type HeadingTag = "h1" | "h2" | "h3" | "h4" | "h5" | "h6";

/**
 * Closed viewer registry. Only text, markdown, and image kinds have native
 * viewers in this slice. Every other kind surfaces an honest `unsupported`
 * state through the shell rather than falling back to a generic renderer that
 * might leak host paths or attempt a network load. The registry is closed
 * (not extensible at runtime) so a malformed manifest kind can never select
 * an unvetted viewer.
 */
export type PreviewViewerKind = "text" | "markdown" | "image";

export interface PreviewViewerProps {
  readonly chunks: ReadonlyArray<PreviewChunk>;
  readonly message?: string;
}

export interface PreviewViewerEntry {
  readonly kind: PreviewViewerKind;
  readonly render: (props: PreviewViewerProps) => ReactNode;
}

const VIEWERS: ReadonlyArray<PreviewViewerEntry> = [
  { kind: "text", render: renderText },
  { kind: "markdown", render: renderMarkdown },
  { kind: "image", render: renderImage },
];

export function selectPreviewViewer(kind: PreviewKind): PreviewViewerEntry | undefined {
  return VIEWERS.find((viewer) => viewer.kind === kind);
}

function renderText(props: PreviewViewerProps): ReactNode {
  const text = collectText(props.chunks);
  return (
    <pre className="preview-viewer preview-viewer--text" data-testid="preview-viewer-text">
      {text === "" ? (props.message ?? "Nothing to show.") : text}
    </pre>
  );
}

function renderMarkdown(props: PreviewViewerProps): ReactNode {
  const text = collectText(props.chunks);
  return (
    <div className="preview-viewer preview-viewer--markdown" data-testid="preview-viewer-markdown">
      {text === "" ? (
        <p role="status">{props.message ?? "Nothing to show."}</p>
      ) : (
        <MarkdownLite text={text} />
      )}
    </div>
  );
}

function renderImage(props: PreviewViewerProps): ReactNode {
  const dataUrl = collectImageDataUrl(props.chunks);
  if (dataUrl === undefined) {
    return (
      <p
        role="status"
        className="preview-viewer preview-viewer--image"
        data-testid="preview-viewer-image"
      >
        {props.message ?? "Image is unavailable."}
      </p>
    );
  }
  return (
    // The data URL is constrained by the contract to data:image/...;base64,...
    // so this img never triggers a network or local-resource load.
    <img
      alt={props.message ?? "Preview image"}
      className="preview-viewer preview-viewer--image"
      data-testid="preview-viewer-image"
      src={dataUrl}
    />
  );
}

function collectText(chunks: ReadonlyArray<PreviewChunk>): string {
  return chunks
    .filter((chunk) => chunk.payload.kind === "text" || chunk.payload.kind === "markdown")
    .map((chunk) =>
      chunk.payload.kind === "text" || chunk.payload.kind === "markdown" ? chunk.payload.text : "",
    )
    .join("");
}

function collectImageDataUrl(chunks: ReadonlyArray<PreviewChunk>): string | undefined {
  for (const chunk of chunks) {
    if (chunk.payload.kind === "image") return chunk.payload.dataUrl;
  }
  return undefined;
}

/**
 * Minimal Markdown renderer that supports headings, bold, italic, code spans,
 * and paragraphs. It does not render raw HTML or script tags — text is escaped
 * before any inline formatting is applied — so a malicious source cannot inject
 * markup into the preview surface. This is intentionally not a full Markdown
 * engine; complex sources surface as `limited-fidelity` or `unsupported`.
 */
function MarkdownLite({ text }: { readonly text: string }) {
  const blocks = splitMarkdownBlocks(text);
  return (
    <>
      {blocks.map((block, index) => {
        if (block.kind === "heading") {
          const level = Math.min(block.level, 6) as 1 | 2 | 3 | 4 | 5 | 6;
          const Tag = `h${level}` as HeadingTag;
          return <Tag key={index}>{renderInline(block.text)}</Tag>;
        }
        if (block.kind === "code") {
          return (
            <pre key={index}>
              <code>{block.text}</code>
            </pre>
          );
        }
        return <p key={index}>{renderInline(block.text)}</p>;
      })}
    </>
  );
}

type MarkdownBlock =
  | { readonly kind: "heading"; readonly level: number; readonly text: string }
  | { readonly kind: "paragraph"; readonly text: string }
  | { readonly kind: "code"; readonly text: string };

function splitMarkdownBlocks(text: string): MarkdownBlock[] {
  const lines = text.split("\n");
  const blocks: MarkdownBlock[] = [];
  let paragraph: string[] = [];
  let codeBuffer: string[] | null = null;
  for (const line of lines) {
    if (codeBuffer !== null) {
      if (line.trimEnd() === "```") {
        blocks.push({ kind: "code", text: codeBuffer.join("\n") });
        codeBuffer = null;
      } else {
        codeBuffer.push(line);
      }
      continue;
    }
    if (line.trimEnd() === "```") {
      if (paragraph.length > 0) {
        blocks.push({ kind: "paragraph", text: paragraph.join("\n") });
        paragraph = [];
      }
      codeBuffer = [];
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading !== null) {
      if (paragraph.length > 0) {
        blocks.push({ kind: "paragraph", text: paragraph.join("\n") });
        paragraph = [];
      }
      blocks.push({ kind: "heading", level: heading[1]!.length, text: heading[2]! });
      continue;
    }
    if (line.trim() === "") {
      if (paragraph.length > 0) {
        blocks.push({ kind: "paragraph", text: paragraph.join("\n") });
        paragraph = [];
      }
      continue;
    }
    paragraph.push(line);
  }
  if (codeBuffer !== null) {
    blocks.push({ kind: "code", text: codeBuffer.join("\n") });
  }
  if (paragraph.length > 0) {
    blocks.push({ kind: "paragraph", text: paragraph.join("\n") });
  }
  return blocks;
}

function renderInline(text: string): ReactNode {
  const escaped = escapeHtml(text);
  // bold **text** and italic *text* and code `text`
  const withCode = escaped.replace(/`([^`]+)`/g, (_m, code: string) => `<code>${code}</code>`);
  const withBold = withCode.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  const withItalic = withBold.replace(/\*([^*]+)\*/g, "<em>$1</em>");
  return <span dangerouslySetInnerHTML={{ __html: withItalic }} />;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
