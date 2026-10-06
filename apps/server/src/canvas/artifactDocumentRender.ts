import type { CanvasBlock, CanvasDefinition } from "@octant/contracts/canvas";
import {
  CANVAS_EXPORT_BODY_MAX_BYTES,
  canvasExportBodyByteLength,
  type CanvasExportImplementedFormat,
} from "@octant/contracts/canvas-export";
import { isCanvasShareSafeText } from "@octant/contracts/canvas-share";
import { DEFAULT_ARTIFACT_PALETTE, escapeXml } from "./artifactRender";

/**
 * The reading form of the same blocks a preview draws.
 *
 * The SVG in `artifactRender` is a glance. This is the document a destination
 * receives: Markdown or HTML, self-contained, with no script and no fetch.
 * Text the share filter would not let leave the host is redacted before either
 * form is built, so export does not invent a second send-out sanitizer.
 * PDF and PNG are not produced here.
 */

export type ArtifactDocumentRender =
  | { readonly kind: "rendered"; readonly title: string; readonly body: string }
  | { readonly kind: "too-large" };

export function renderArtifactMarkdown(
  definition: Pick<CanvasDefinition, "title" | "blocks">,
): ArtifactDocumentRender {
  return renderDocument(definition, "markdown");
}

export function renderArtifactHtml(
  definition: Pick<CanvasDefinition, "title" | "blocks">,
): ArtifactDocumentRender {
  return renderDocument(definition, "html");
}

export function renderArtifactDocument(
  definition: Pick<CanvasDefinition, "title" | "blocks">,
  format: CanvasExportImplementedFormat,
): ArtifactDocumentRender {
  return format === "html" ? renderArtifactHtml(definition) : renderArtifactMarkdown(definition);
}

type Piece =
  | { readonly kind: "heading"; readonly level: number; readonly text: string }
  | { readonly kind: "paragraph"; readonly text: string }
  | { readonly kind: "list"; readonly items: ReadonlyArray<string> }
  | {
      readonly kind: "table";
      readonly headers: ReadonlyArray<string>;
      readonly rows: ReadonlyArray<ReadonlyArray<string>>;
    }
  | { readonly kind: "code"; readonly text: string }
  | { readonly kind: "rule" };

function finish(title: string, body: string): ArtifactDocumentRender {
  return canvasExportBodyByteLength(body) <= CANVAS_EXPORT_BODY_MAX_BYTES
    ? { kind: "rendered", title, body }
    : { kind: "too-large" };
}

function reading(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) return "";
  return isCanvasShareSafeText(trimmed) ? trimmed : "[redacted]";
}

function scalar(value: string | number | boolean | null): string {
  if (value === null) return "";
  if (typeof value === "string") return reading(value);
  return String(value);
}

function renderDocument(
  definition: Pick<CanvasDefinition, "title" | "blocks">,
  format: CanvasExportImplementedFormat,
): ArtifactDocumentRender {
  const pieces: Piece[] = [];
  for (const block of definition.blocks) {
    pieces.push(...piecesFor(block));
  }
  const title = reading(definition.title) || "Canvas";
  const body = format === "html" ? htmlDocument(title, pieces) : markdownDocument(title, pieces);
  return finish(title, body);
}

function piecesFor(block: CanvasBlock): ReadonlyArray<Piece> {
  switch (block.kind) {
    case "heading":
      return [{ kind: "heading", level: Math.min(6, block.level + 1), text: reading(block.text) }];
    case "rich-text":
      return paragraph(reading(block.text));
    case "callout":
      return paragraph(
        [block.title === undefined ? "" : reading(block.title), reading(block.text)]
          .filter((part) => part.length > 0)
          .join(" — "),
      );
    case "link":
      return paragraph(linkText(reading(block.label), block.href));
    case "divider":
      return [{ kind: "rule" }];
    case "citation":
      return paragraph(
        [reading(block.label), block.quote === undefined ? "" : reading(block.quote)]
          .filter((part) => part.length > 0)
          .join(": "),
      );
    case "metric":
      return paragraph(
        `${reading(block.label)}: ${scalar(block.value)}${block.unit === undefined ? "" : ` ${reading(block.unit)}`}`,
      );
    case "progress":
      return paragraph(
        `${reading(block.label)}: ${String(Math.round(block.value * 100))}%${block.detail === undefined ? "" : ` — ${reading(block.detail)}`}`,
      );
    case "status":
      return paragraph(`${reading(block.label)}: ${reading(block.value)}`);
    case "key-value":
      return [
        {
          kind: "table",
          headers: ["Field", "Value"],
          rows: block.entries.map((entry) => [reading(entry.key), scalar(entry.value)]),
        },
      ];
    case "table":
      return [
        {
          kind: "table",
          headers: block.columns.map((column) => reading(column.label)),
          rows: block.rows.map((row) =>
            block.columns.map((_, index) => scalar(row[index] ?? null)),
          ),
        },
      ];
    case "chart":
      return [
        {
          kind: "list",
          items: block.series.flatMap((series) =>
            series.points.map(
              (point) => `${reading(series.label)}: ${scalar(point.x)} = ${String(point.y)}`,
            ),
          ),
        },
      ];
    case "timeline":
      return [
        {
          kind: "list",
          items: block.items.map((item) =>
            [reading(item.title), item.detail === undefined ? "" : reading(item.detail)]
              .filter((part) => part.length > 0)
              .join(" — "),
          ),
        },
      ];
    case "diagram": {
      const names = new Map(block.nodes.map((node) => [String(node.nodeId), reading(node.label)]));
      return [
        {
          kind: "list",
          items: [
            ...block.nodes.map((node) => reading(node.label)),
            ...block.edges.map((edge) => {
              const from = names.get(String(edge.source)) ?? "node";
              const to = names.get(String(edge.target)) ?? "node";
              const label = edge.label === undefined ? "" : reading(edge.label);
              return label.length === 0 ? `${from} → ${to}` : `${from} → ${to}: ${label}`;
            }),
          ],
        },
      ];
    }
    case "sequence": {
      const names = new Map(
        block.participants.map((participant) => [
          String(participant.participantId),
          reading(participant.label),
        ]),
      );
      return [
        {
          kind: "list",
          items: [
            ...block.messages.map((message) => {
              const from = names.get(String(message.from)) ?? "participant";
              const to = names.get(String(message.to)) ?? "participant";
              return `${from} → ${to}: ${reading(message.label)}`;
            }),
            ...(block.notes ?? []).map((note) => reading(note.text)),
          ],
        },
      ];
    }
    case "state": {
      const names = new Map(
        block.states.map((state) => [String(state.stateId), reading(state.label)]),
      );
      return [
        {
          kind: "list",
          items: [
            ...block.states.map((state) => reading(state.label)),
            ...block.transitions.map((transition) => {
              const from = names.get(String(transition.source)) ?? "state";
              const to = names.get(String(transition.target)) ?? "state";
              return `${from} → ${to}: ${reading(transition.label)}`;
            }),
          ],
        },
      ];
    }
    case "code-excerpt":
    case "pseudocode":
      return [{ kind: "code", text: reading(block.code) }];
    case "diff":
      return [
        {
          kind: "code",
          text: block.hunks
            .map((hunk) =>
              [
                reading(hunk.header),
                ...hunk.lines.map((line) => {
                  const prefix = line.kind === "add" ? "+" : line.kind === "remove" ? "-" : " ";
                  return `${prefix} ${reading(line.text)}`;
                }),
              ].join("\n"),
            )
            .join("\n"),
        },
      ];
    case "summary":
      return [
        { kind: "heading", level: 2, text: reading(block.title) },
        {
          kind: "list",
          items: block.items.map((item) =>
            item.value === undefined
              ? reading(item.label)
              : `${reading(item.label)}: ${scalar(item.value)}`,
          ),
        },
      ];
    case "source-reference":
    case "artifact-reference":
    case "file-reference":
    case "preview-reference":
    case "browser-reference":
    case "evidence-reference":
      return paragraph(
        [reading(block.label), block.detail === undefined ? "" : reading(block.detail)]
          .filter((part) => part.length > 0)
          .join(" — "),
      );
    case "image":
      return paragraph(
        [reading(block.alt), block.caption === undefined ? "" : reading(block.caption)]
          .filter((part) => part.length > 0)
          .join(" — "),
      );
    case "mockup":
      return [
        { kind: "heading", level: 2, text: reading(block.title) },
        {
          kind: "list",
          items: block.nodes.map((node) => `${node.component}: ${reading(node.label)}`),
        },
      ];
    case "plan": {
      const phases = new Map(
        block.phases.map((phase) => [String(phase.phaseId), reading(phase.title)]),
      );
      return [
        { kind: "heading", level: 2, text: reading(block.title) },
        {
          kind: "list",
          items: block.tasks.map((task) => {
            const phase = phases.get(String(task.phaseId)) ?? "";
            const prefix = phase.length === 0 ? "" : `${phase}: `;
            return `${prefix}${reading(task.title)} (${task.status})`;
          }),
        },
      ];
    }
    case "action":
      return paragraph(
        [reading(block.label), block.description === undefined ? "" : reading(block.description)]
          .filter((part) => part.length > 0)
          .join(" — "),
      );
    default: {
      const unhandled: never = block;
      return unhandled;
    }
  }
}

function paragraph(text: string): ReadonlyArray<Piece> {
  return text.length === 0 ? [] : [{ kind: "paragraph", text }];
}

function linkText(label: string, href: string): string {
  if (label.length === 0) return "";
  if (!safeHttpUrl(href)) return label;
  return `[${label}](${href})`;
}

function safeHttpUrl(value: string): boolean {
  if (!isCanvasShareSafeText(value)) return false;
  try {
    const parsed = new URL(value);
    return (
      (parsed.protocol === "http:" || parsed.protocol === "https:") &&
      parsed.username === "" &&
      parsed.password === ""
    );
  } catch {
    return false;
  }
}

function markdownDocument(title: string, pieces: ReadonlyArray<Piece>): string {
  const lines = [`# ${inline(title)}`, ""];
  for (const piece of pieces) {
    lines.push(markdownPiece(piece), "");
  }
  return lines.join("\n").trimEnd() + "\n";
}

function markdownPiece(piece: Piece): string {
  switch (piece.kind) {
    case "heading":
      return `${"#".repeat(piece.level)} ${inline(piece.text)}`;
    case "paragraph":
      return inline(piece.text);
    case "list":
      return piece.items.map((item) => `- ${inline(item)}`).join("\n");
    case "table":
      return [
        `| ${piece.headers.map(cell).join(" | ")} |`,
        `| ${piece.headers.map(() => "---").join(" | ")} |`,
        ...piece.rows.map((row) => `| ${row.map(cell).join(" | ")} |`),
      ].join("\n");
    case "code":
      return `\`\`\`\n${piece.text.replace(/```/g, "'''")}\n\`\`\``;
    case "rule":
      return "---";
    default: {
      const unhandled: never = piece;
      return unhandled;
    }
  }
}

function inline(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function cell(value: string): string {
  // Backslashes first: a cell ending in `\` would otherwise cancel the escape on
  // the next pipe and split the row.
  return inline(value).replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/\n/g, " ");
}

function htmlDocument(title: string, pieces: ReadonlyArray<Piece>): string {
  const palette = DEFAULT_ARTIFACT_PALETTE;
  const style = [
    `body{font-family:system-ui,sans-serif;background:${palette.background};color:${palette.ink};margin:24px;line-height:1.45}`,
    "h1{font-size:20px}h2,h3,h4,h5,h6{font-size:16px}",
    `table{border-collapse:collapse}td,th{border:1px solid ${palette.muted};padding:4px 8px;text-align:left}`,
    "pre{white-space:pre-wrap}",
    "a{color:inherit}",
  ].join("");
  const body = pieces.map(htmlPiece).join("");
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>${escapeXml(title)}</title><style>${style}</style></head><body><h1>${escapeXml(title)}</h1>${body}</body></html>\n`;
}

function htmlPiece(piece: Piece): string {
  switch (piece.kind) {
    case "heading":
      return `<h${String(piece.level)}>${htmlInline(piece.text)}</h${String(piece.level)}>`;
    case "paragraph":
      return `<p>${htmlInline(piece.text)}</p>`;
    case "list":
      return `<ul>${piece.items.map((item) => `<li>${htmlInline(item)}</li>`).join("")}</ul>`;
    case "table":
      return `<table><thead><tr>${piece.headers.map((header) => `<th>${escapeXml(header)}</th>`).join("")}</tr></thead><tbody>${piece.rows
        .map((row) => `<tr>${row.map((value) => `<td>${escapeXml(value)}</td>`).join("")}</tr>`)
        .join("")}</tbody></table>`;
    case "code":
      return `<pre>${escapeXml(piece.text)}</pre>`;
    case "rule":
      return "<hr>";
    default: {
      const unhandled: never = piece;
      return unhandled;
    }
  }
}

/** Markdown links stay links in HTML; everything else is escaped text. */
function htmlInline(value: string): string {
  const match = /^\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)$/.exec(value);
  if (match === null) return escapeXml(value);
  const label = match[1];
  const href = match[2];
  if (label === undefined || href === undefined || !safeHttpUrl(href)) return escapeXml(value);
  return `<a href="${escapeXml(href)}">${escapeXml(label)}</a>`;
}
