import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const webRoot = join(process.cwd(), "src");

// Pages a person never opens: tests, their fixtures, the component gallery,
// the visual-check scenes and the developer harness pages.
const NOT_THE_PRODUCT =
  /\.test\.|test-support|[Ff]ixtures|[/\\](gallery|visualCheck)[/\\]|Harness\.tsx$/;

function productSources(directory: string): ReadonlyArray<string> {
  const found: string[] = [];
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) found.push(...productSources(path));
    else if (/\.tsx?$/.test(entry) && !NOT_THE_PRODUCT.test(path)) found.push(path);
  }
  return found;
}

interface Sentence {
  readonly where: string;
  readonly text: string;
}

/** A comment may quote the very words this file refuses, so it is not read. */
function withoutComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, " "))
    .replace(/(^|[^:"'`\\])\/\/[^\n]*/g, "$1");
}

// A prop or a field whose value is shown as it stands, however short.
const SHOWN_AS_IT_STANDS =
  /\b(?:aria-label|label|title|placeholder|message|detail|description|eyebrow|tooltip|text|heading|summary|caption|hint|note)\s*[=:]\s*\{?\s*(?:"([^"\n]*)"|'([^'\n]*)'|`([^`\n]*)`)/g;
const QUOTED = /"([^"\n]*)"|'([^'\n]*)'|`([^`\n]*)`/g;
// Text between two tags on one line. A tag ends against its name, a quote or a
// brace and the next begins at once; a comparison has a space on both sides.
const BETWEEN_TAGS = /(?<=\S)>([^<>{}\n]+)<(?=[/A-Za-z])/g;
const CODE_NOT_PROSE = /&&|\|\||=|;|^[([]/;
// A line of running text inside an element: no brace, bracket, tag or
// assignment on it, and it does not end the way a statement or a field does.
const PROSE_LINE = /^[A-Za-z’'“"][^=(){}[\]<>]*[^=(){}[\]<>,;:]$/;
const STARTS_A_STATEMENT =
  /^(?:readonly|const|let|var|return|import|export|case|default|type|interface|break|continue|else|try|finally|async|await|throw|function|yield|static|public|private|declare|extends|implements)\b/;
// A label written in braces between two tags, or on a line of its own.
const BRACED_LABEL = /(?:(?<=>)|^)\s*\{\s*(?:"([^"\n]*)"|'([^'\n]*)'|`([^`\n]*)`)\s*\}\s*(?=<|$)/g;
// One or two capitalised words alone on a line: a button's or a heading's
// text after the formatter has broken the tag around it.
const SHORT_LABEL_LINE = /^[A-Z][A-Za-z’'-]*(?: [A-Za-z’'-]+)?[.…!?]?$/;
// An expression broken over lines can look like a line of words: it gives
// itself away with an operator, a keyword or a member read.
const AN_EXPRESSION =
  /&&|\|\||\?\?|=>|\?\.|\b(?:instanceof|typeof|keyof|satisfies)\b|[A-Za-z_]\.[A-Za-z_]/;

function plain(text: string): string {
  return text
    .replace(/\$\{[^}]*\}/g, "…")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * The strings a person can read. Five shapes are read: a prop or field shown
 * as it stands (a label, a title, a message), any other quoted string that
 * starts with a capital and holds at least two words, the text between two
 * tags (written plainly or as a string in braces), a line of running text
 * inside an element, and one or two capitalised words alone on a line. Class lists, selectors,
 * identifiers and Settings search keywords start in lower case or hold no
 * space, so they fall out. A sentence that starts in lower case inside a plain
 * string is not read; that is the price of leaving keywords alone.
 */
function readableSentences(path: string): ReadonlyArray<Sentence> {
  const sentences: Sentence[] = [];
  const lines = withoutComments(readFileSync(path, "utf8")).split("\n");
  for (const [index, line] of lines.entries()) {
    const where = `${relative(webRoot, path)}:${index + 1}`;
    const add = (raw: string | undefined) => {
      if (raw === undefined) return;
      const text = plain(raw);
      if (/[A-Za-z]/.test(text)) sentences.push({ where, text });
    };
    for (const match of line.matchAll(SHOWN_AS_IT_STANDS)) {
      const value = match[1] ?? match[2] ?? match[3] ?? "";
      if (/^[A-Z]/.test(value.trim())) add(value);
    }
    for (const match of line.matchAll(QUOTED)) {
      const value = plain(match[1] ?? match[2] ?? match[3] ?? "");
      if (/\s/.test(value) && /^[A-Z…]/.test(value)) add(value);
    }
    for (const match of line.matchAll(BETWEEN_TAGS)) {
      if (!CODE_NOT_PROSE.test((match[1] ?? "").trim())) add(match[1]);
    }
    const bare = line.trim();
    for (const match of bare.matchAll(BRACED_LABEL)) add(match[1] ?? match[2] ?? match[3]);
    if (SHORT_LABEL_LINE.test(bare)) add(bare);
    if (
      PROSE_LINE.test(bare) &&
      bare.split(/\s+/).length >= 3 &&
      !STARTS_A_STATEMENT.test(bare) &&
      !AN_EXPRESSION.test(bare) &&
      !/["'`]/.test(bare)
    ) {
      add(bare);
    }
  }
  return sentences;
}

const sentences = productSources(webRoot).flatMap(readableSentences);

// The host's own reason text, which the Agents page compares and replaces with
// its own sentence before anything is shown.
const COMPARED_NEVER_SHOWN: ReadonlyArray<string> = [
  "Managed AgentRun turn exceeded its runtime deadline.",
];

function sentencesSaying(word: RegExp): ReadonlyArray<string> {
  return [
    ...new Set(
      sentences
        .filter(({ text }) => word.test(text) && !COMPARED_NEVER_SHOWN.includes(text))
        .map(({ where, text }) => `${where} ${text}`),
    ),
  ];
}

/** Every opening tag in the source, whole, wherever its `>` falls. */
function openingTags(source: string): ReadonlyArray<{ readonly at: number; readonly tag: string }> {
  const tags: { at: number; tag: string }[] = [];
  for (const start of source.matchAll(/<[A-Z][A-Za-z0-9.]*[\s/>]/g)) {
    let depth = 0;
    let quote: string | undefined;
    for (let index = start.index + 1; index < source.length; index += 1) {
      const char = source[index];
      if (quote !== undefined) {
        if (char === quote && source[index - 1] !== "\\") quote = undefined;
      } else if (char === '"' || char === "'" || char === "`") quote = char;
      else if (char === "{") depth += 1;
      else if (char === "}") depth -= 1;
      else if (char === ">" && depth === 0) {
        tags.push({ at: start.index, tag: source.slice(start.index, index + 1) });
        break;
      }
    }
  }
  return tags;
}

// The lines kept under a spinner: each says what its title cannot.
const SAYS_WHAT_THE_TITLE_CANNOT: ReadonlyArray<string> = [
  "Your draft is kept on this device. Send it once you are reconnected; nothing is sent for you.",
  "The host will be asked to approve this browser.",
  "This browser's key does not leave this device.",
];

describe("the interface says things in plain words", () => {
  // DESIGN.md, Voice: the word "target" does not appear in the interface. What
  // a thread or a routine is for is its delivery; where it goes is a
  // destination, a Project or a thread.
  it("never says target", () => {
    expect(sentencesSaying(/\b(re)?target(s|ed|ing)?\b/i)).toEqual([]);
  });

  // "Loading authoritative shell state." was the first sentence the app showed
  // (seen 2026-11-25). It names the mechanism, not what the person waits for.
  it("never calls its own state authoritative", () => {
    expect(sentencesSaying(/\bauthoritative\b/i)).toEqual([]);
  });

  it("never shows a type name from the code", () => {
    expect(sentencesSaying(/\bAgentRun\b/)).toEqual([]);
  });

  // DESIGN.md, Voice: Automations, never "routine".
  it("calls automations Automations, never routine", () => {
    expect(sentencesSaying(/\broutines?\b/i)).toEqual([]);
  });

  // DESIGN.md, Plain words: a loading state is its title alone. A message
  // under a spinner repeated its title on thirty screens ("Loading workspace"
  // over "Loading workspace."). A state that is only sometimes loading passes
  // its message through a spread, so the loading case can leave it out.
  it("draws a loading state as its title alone", () => {
    const withMessage: string[] = [];
    for (const path of productSources(webRoot)) {
      const source = withoutComments(readFileSync(path, "utf8"));
      for (const { at, tag } of openingTags(source)) {
        const mayLoad = /\bstate="loading"/.test(tag)
          ? true
          : tag.startsWith("<OctantEmpty") && /\bstate=\{[^}]*"loading"/.test(tag);
        if (!mayLoad) continue;
        const message = /\bmessage=(?:"([^"]*)"|(\{))/.exec(tag);
        if (message === null) continue;
        if (message[1] !== undefined && SAYS_WHAT_THE_TITLE_CANNOT.includes(message[1])) continue;
        withMessage.push(`${relative(webRoot, path)}:${source.slice(0, at).split("\n").length}`);
      }
    }
    expect(withMessage).toEqual([]);
  });
});
