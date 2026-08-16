import type { ChatMessagePart, ChatToolPartStatus } from "@octant/contracts";

/**
 * Distilled message-part resolution for Octant clients.
 * Prefer structured `parts` when present; otherwise parse body conventions.
 * Shared by mobile now; web/desktop Distilled adoption later.
 */

export type MarkdownBlock =
  | { readonly type: "paragraph"; readonly text: string }
  | { readonly type: "heading"; readonly level: 1 | 2 | 3; readonly text: string }
  | { readonly type: "list"; readonly ordered: boolean; readonly items: ReadonlyArray<string> }
  | { readonly type: "code"; readonly language: string | undefined; readonly code: string };

const FENCE = /```([^\n`]*)\n([\s\S]*?)```/g;
const THINKING_TAG = /<thinking>([\s\S]*?)<\/thinking>/gi;
const REASONING_TAG = /<reasoning>([\s\S]*?)<\/reasoning>/gi;

function normalizeStatus(raw: string | undefined): ChatToolPartStatus {
  const value = (raw ?? "").toLowerCase();
  if (value.includes("fail") || value.includes("error") || value.includes("denied")) {
    return "failed";
  }
  if (value.includes("run") || value.includes("progress") || value.includes("start")) {
    return "running";
  }
  return "done";
}

function parseToolMeta(info: string): { name: string; status: ChatToolPartStatus } {
  const trimmed = info.trim();
  const nameMatch = /(?:name\s*=\s*["']?([\w./:-]+)["']?|^([\w./:-]+))/i.exec(trimmed);
  const statusMatch = /status\s*=\s*["']?([\w-]+)["']?/i.exec(trimmed);
  const name = nameMatch?.[1] ?? nameMatch?.[2] ?? "tool";
  return { name, status: normalizeStatus(statusMatch?.[1] ?? trimmed) };
}

/**
 * Split a host message body into reasoning / tool / markdown parts.
 * Recognizes ```reasoning|thinking fences, ```tool fences, and <thinking> tags.
 */
export function parseChatMessageBody(body: string): ReadonlyArray<ChatMessagePart> {
  if (body.length === 0) return [{ kind: "markdown", text: "" }];

  const parts: ChatMessagePart[] = [];
  let cursor = 0;
  const annotated: Array<{ start: number; end: number; part: ChatMessagePart }> = [];

  for (const match of body.matchAll(THINKING_TAG)) {
    const start = match.index ?? 0;
    annotated.push({
      start,
      end: start + match[0].length,
      part: { kind: "reasoning", text: (match[1] ?? "").trim() },
    });
  }
  for (const match of body.matchAll(REASONING_TAG)) {
    const start = match.index ?? 0;
    annotated.push({
      start,
      end: start + match[0].length,
      part: { kind: "reasoning", text: (match[1] ?? "").trim() },
    });
  }
  for (const match of body.matchAll(FENCE)) {
    const start = match.index ?? 0;
    const info = (match[1] ?? "").trim();
    const code = match[2] ?? "";
    const lang = info.split(/\s+/)[0]?.toLowerCase() ?? "";
    if (lang === "reasoning" || lang === "thinking") {
      annotated.push({
        start,
        end: start + match[0].length,
        part: { kind: "reasoning", text: code.trim() },
      });
      continue;
    }
    if (lang === "tool") {
      const meta = parseToolMeta(info.slice(lang.length));
      annotated.push({
        start,
        end: start + match[0].length,
        part: {
          kind: "tool",
          name: meta.name,
          status: meta.status,
          summary: code.trim(),
        },
      });
    }
  }

  annotated.sort((a, b) => a.start - b.start);
  for (const item of annotated) {
    if (item.start < cursor) continue;
    if (item.start > cursor) {
      const text = body.slice(cursor, item.start).trim();
      if (text.length > 0) parts.push({ kind: "markdown", text });
    }
    if (item.part.kind === "reasoning" && item.part.text.length === 0) {
      cursor = item.end;
      continue;
    }
    parts.push(item.part);
    cursor = item.end;
  }
  if (cursor < body.length) {
    const text = body.slice(cursor).trim();
    if (text.length > 0) parts.push({ kind: "markdown", text });
  }
  if (parts.length === 0) return [{ kind: "markdown", text: body }];
  return parts;
}

/** Prefer structured parts; otherwise derive from role + body text. */
export function resolveChatMessageParts(input: {
  readonly role: string;
  readonly body: string;
  readonly parts?: ReadonlyArray<ChatMessagePart>;
}): ReadonlyArray<ChatMessagePart> {
  if (input.parts !== undefined && input.parts.length > 0) {
    return input.parts;
  }
  if (input.role.toLowerCase() === "research") {
    return [{ kind: "reasoning", text: input.body }];
  }
  return parseChatMessageBody(input.body);
}

/** Parse a markdown substring into renderable blocks (no dependency). */
export function parseMarkdownBlocks(source: string): ReadonlyArray<MarkdownBlock> {
  const blocks: MarkdownBlock[] = [];
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  let i = 0;

  while (i < lines.length) {
    const line = lines[i] ?? "";
    if (line.trim().length === 0) {
      i += 1;
      continue;
    }

    if (line.startsWith("```")) {
      const language = line.slice(3).trim() || undefined;
      const codeLines: string[] = [];
      i += 1;
      while (i < lines.length && !(lines[i] ?? "").startsWith("```")) {
        codeLines.push(lines[i] ?? "");
        i += 1;
      }
      if (i < lines.length) i += 1;
      blocks.push({ type: "code", language, code: codeLines.join("\n") });
      continue;
    }

    const heading = /^(#{1,3})\s+(.+)$/.exec(line);
    if (heading) {
      blocks.push({
        type: "heading",
        level: heading[1]!.length as 1 | 2 | 3,
        text: heading[2]!.trim(),
      });
      i += 1;
      continue;
    }

    if (/^\s*[-*]\s+/.test(line) || /^\s*\d+\.\s+/.test(line)) {
      const ordered = /^\s*\d+\.\s+/.test(line);
      const items: string[] = [];
      while (i < lines.length) {
        const itemLine = lines[i] ?? "";
        const bullet = ordered
          ? /^\s*\d+\.\s+(.+)$/.exec(itemLine)
          : /^\s*[-*]\s+(.+)$/.exec(itemLine);
        if (!bullet) break;
        items.push(bullet[1]!.trim());
        i += 1;
      }
      blocks.push({ type: "list", ordered, items });
      continue;
    }

    const para: string[] = [line];
    i += 1;
    while (i < lines.length) {
      const next = lines[i] ?? "";
      if (
        next.trim().length === 0 ||
        next.startsWith("```") ||
        /^#{1,3}\s+/.test(next) ||
        /^\s*[-*]\s+/.test(next) ||
        /^\s*\d+\.\s+/.test(next)
      ) {
        break;
      }
      para.push(next);
      i += 1;
    }
    blocks.push({ type: "paragraph", text: para.join(" ").trim() });
  }

  return blocks;
}
