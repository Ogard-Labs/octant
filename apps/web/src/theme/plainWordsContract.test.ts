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

/**
 * The strings a person can read: a quoted or template string that starts with
 * a capital and holds at least two words, and the text between two JSX tags.
 * Class lists, selectors, identifiers and Settings search keywords start in
 * lower case or hold no space, so they fall out; a comment line is skipped,
 * since it may quote the very words this file refuses.
 */
function readableSentences(path: string): ReadonlyArray<Sentence> {
  const sentences: Sentence[] = [];
  const lines = readFileSync(path, "utf8").split("\n");
  for (const [index, line] of lines.entries()) {
    const trimmed = line.trimStart();
    if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) continue;
    const where = `${relative(webRoot, path)}:${index + 1}`;
    for (const match of line.matchAll(/"([^"\n]*)"|`([^`\n]*)`|>([^<>{}\n]+)</g)) {
      const quoted = match[1] ?? match[2];
      const text = (quoted ?? match[3] ?? "").replace(/\$\{[^}]*\}/g, "…").trim();
      if (!/\s/.test(text)) continue;
      if (quoted !== undefined && !/^[A-Z…]/.test(text)) continue;
      sentences.push({ where, text });
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
  return sentences
    .filter(({ text }) => word.test(text) && !COMPARED_NEVER_SHOWN.includes(text))
    .map(({ where, text }) => `${where} ${text}`);
}

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

  // OctantEmpty: "a loading line is the title alone". A message under a
  // spinner repeated its title on thirty screens ("Loading workspace" over
  // "Loading workspace.").
  it("draws a loading state as its title alone", () => {
    const withMessage: string[] = [];
    for (const path of productSources(webRoot)) {
      const source = readFileSync(path, "utf8");
      for (const block of source.matchAll(/<OctantEmpty\b[^>]*?\/>/gs)) {
        if (!/state="loading"/.test(block[0]) || !/\bmessage="/.test(block[0])) continue;
        // The one loading state with something to add: a lost connection says
        // what happens to the draft while it reconnects.
        if (/title="Reconnecting"/.test(block[0])) continue;
        const line = source.slice(0, block.index).split("\n").length;
        withMessage.push(`${relative(webRoot, path)}:${line}`);
      }
    }
    expect(withMessage).toEqual([]);
  });
});
