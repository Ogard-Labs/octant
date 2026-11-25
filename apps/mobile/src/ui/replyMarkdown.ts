export type ReplySegment =
  | { readonly kind: "prose"; readonly markdown: string }
  | { readonly kind: "code"; readonly language?: string; readonly code: string };

const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([^\s`]*)[^`]*$/;

/**
 * A reply as prose for the system's text and code for its own block. A fence
 * still being written is code already, so a streaming reply does not jump.
 */
export function replySegments(text: string): ReadonlyArray<ReplySegment> {
  const segments: ReplySegment[] = [];
  let prose: string[] = [];
  let code: string[] | undefined;
  let fence = "";
  let language = "";
  const endProse = () => {
    const markdown = withoutRemoteMedia(prose.join("\n").replace(/^\n+|\s+$/g, ""));
    if (markdown.length > 0) segments.push({ kind: "prose", markdown });
    prose = [];
  };
  const endCode = () => {
    segments.push({
      kind: "code",
      ...(language === "" ? {} : { language }),
      code: (code ?? []).join("\n"),
    });
    code = undefined;
  };
  for (const line of text.split("\n")) {
    const match = FENCE.exec(line);
    const mark = match?.[1] ?? "";
    if (code !== undefined) {
      const closes =
        mark !== "" && mark[0] === fence[0] && mark.length >= fence.length && match?.[2] === "";
      if (closes) endCode();
      else code.push(line);
    } else if (mark !== "") {
      endProse();
      fence = mark;
      language = match?.[2] ?? "";
      code = [];
    } else {
      prose.push(line);
    }
  }
  if (code !== undefined) endCode();
  endProse();
  return segments;
}

// Invisible, and enough to stop the two characters around it being read as one
// piece of syntax.
const APART = "\u200B";

/**
 * A picture in a reply becomes a link to it. Drawing one would have the phone
 * ask an address the reply chose, which tells that address where the person is
 * and when they read it.
 *
 * The plain form is rewritten so that it reads well. Every other way to write a
 * picture (nested brackets, references, unbalanced code) starts with the same
 * two characters, so parting those wherever they are left is what holds. Markup
 * that loads something is parted the same way.
 */
function withoutRemoteMedia(markdown: string): string {
  return markdown
    .replace(
      /(^|[^`\\])!\[([^[\]\n\\]{0,300})\]\(([^\s()<>]{1,2000})(?:[ \t]+["'][^"'\n]{0,300}["'])?\)/g,
      (_whole, before: string, alt: string, url: string) =>
        `${before}[${alt.trim() === "" ? url : alt}](${url})`,
    )
    .replaceAll("![", `!${APART}[`)
    .replace(
      /<(?=\/?(?:img|image|video|audio|source|track|picture|iframe|object|embed|svg|link|style)\b)/gi,
      `<${APART}`,
    );
}
