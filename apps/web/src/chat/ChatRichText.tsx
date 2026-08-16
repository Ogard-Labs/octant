import { Fragment, type ReactNode } from "react";

export interface ChatRichTextProps {
  readonly body: string;
}

type RichBlock =
  | { readonly kind: "code"; readonly language?: string; readonly text: string }
  | { readonly kind: "heading"; readonly level: 2 | 3 | 4; readonly text: string }
  | { readonly kind: "list"; readonly ordered: boolean; readonly items: readonly string[] }
  | { readonly kind: "paragraph"; readonly text: string }
  | { readonly kind: "quote"; readonly text: string };

export function ChatRichText(props: ChatRichTextProps) {
  return (
    <div className="chat-rich-text">
      {parseBlocks(props.body).map((block, index) => (
        <RichBlockView block={block} key={`${block.kind}-${index}`} />
      ))}
    </div>
  );
}

function RichBlockView(props: { readonly block: RichBlock }) {
  const block = props.block;
  switch (block.kind) {
    case "code":
      return (
        <div className="chat-rich-text__code">
          {block.language === undefined ? null : <span>{block.language}</span>}
          <pre>
            <code>{block.text}</code>
          </pre>
        </div>
      );
    case "heading": {
      const Heading = `h${block.level}` as "h2" | "h3" | "h4";
      return <Heading>{inlineContent(block.text)}</Heading>;
    }
    case "list": {
      const List = block.ordered ? "ol" : "ul";
      return (
        <List>
          {block.items.map((item, index) => (
            <li key={`${item}-${index}`}>{inlineContent(item)}</li>
          ))}
        </List>
      );
    }
    case "quote":
      return <blockquote>{inlineContent(block.text)}</blockquote>;
    case "paragraph":
      return <p>{inlineContent(block.text)}</p>;
  }
}

function parseBlocks(body: string): RichBlock[] {
  const lines = body.replaceAll("\r\n", "\n").split("\n");
  const blocks: RichBlock[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index] ?? "";
    if (line.trim() === "") {
      index += 1;
      continue;
    }
    const fence = line.match(/^```([^\s`]*)\s*$/);
    if (fence !== null) {
      const code: string[] = [];
      index += 1;
      while (index < lines.length && !/^```\s*$/.test(lines[index] ?? "")) {
        code.push(lines[index] ?? "");
        index += 1;
      }
      if (index < lines.length) index += 1;
      blocks.push({
        kind: "code",
        ...(fence[1] === "" ? {} : { language: fence[1] }),
        text: code.join("\n"),
      });
      continue;
    }
    const heading = line.match(/^(#{1,3})\s+(.+)$/);
    if (heading !== null) {
      blocks.push({
        kind: "heading",
        level: Math.min(heading[1]!.length + 1, 4) as 2 | 3 | 4,
        text: heading[2]!,
      });
      index += 1;
      continue;
    }
    const unordered = line.match(/^[-*]\s+(.+)$/);
    const ordered = line.match(/^\d+[.)]\s+(.+)$/);
    if (unordered !== null || ordered !== null) {
      const isOrdered = ordered !== null;
      const items: string[] = [];
      while (index < lines.length) {
        const match = (lines[index] ?? "").match(isOrdered ? /^\d+[.)]\s+(.+)$/ : /^[-*]\s+(.+)$/);
        if (match === null) break;
        items.push(match[1]!);
        index += 1;
      }
      blocks.push({ kind: "list", ordered: isOrdered, items });
      continue;
    }
    if (line.startsWith("> ")) {
      const quote: string[] = [];
      while (index < lines.length && (lines[index] ?? "").startsWith("> ")) {
        quote.push((lines[index] ?? "").slice(2));
        index += 1;
      }
      blocks.push({ kind: "quote", text: quote.join("\n") });
      continue;
    }
    const paragraph = [line];
    index += 1;
    while (index < lines.length && !startsBlock(lines[index] ?? "")) {
      paragraph.push(lines[index] ?? "");
      index += 1;
    }
    blocks.push({ kind: "paragraph", text: paragraph.join("\n") });
  }
  return blocks;
}

function startsBlock(line: string): boolean {
  return (
    line.trim() === "" ||
    line.startsWith("```") ||
    /^(#{1,3})\s+/.test(line) ||
    /^[-*]\s+/.test(line) ||
    /^\d+[.)]\s+/.test(line) ||
    line.startsWith("> ")
  );
}

function inlineContent(text: string): ReactNode {
  const tokens = text.split(/(\*\*[^*\n]+\*\*|`[^`\n]+`|\[[^\]\n]+\]\([^)\n]+\)|\n)/g);
  return tokens.map((token, index) => {
    if (token === "\n") return <br key={index} />;
    if (token.startsWith("**") && token.endsWith("**")) {
      return <strong key={index}>{token.slice(2, -2)}</strong>;
    }
    if (token.startsWith("`") && token.endsWith("`")) {
      return <code key={index}>{token.slice(1, -1)}</code>;
    }
    const link = token.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
    if (link !== null) {
      const href = safeLink(link[2]!);
      return href === undefined ? (
        <Fragment key={index}>{link[1]}</Fragment>
      ) : (
        <a href={href} key={index} rel="noreferrer" target="_blank">
          {link[1]}
        </a>
      );
    }
    return <Fragment key={index}>{token}</Fragment>;
  });
}

function safeLink(value: string): string | undefined {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : undefined;
  } catch {
    return undefined;
  }
}
