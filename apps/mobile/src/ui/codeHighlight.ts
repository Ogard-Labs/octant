import type { HighlighterCore, LanguageRegistration, ThemedToken } from "@shikijs/core";

/**
 * Syntax colours for code in replies and diffs, drawn by Shiki's grammars on
 * its JavaScript regex engine. Hermes runs no WebAssembly and rejects the `v`
 * regex flag and inline modifiers, so the engine converts every pattern to
 * ES2018 regexes. A probe of the grammars below on 2026-11-26 found every
 * pattern accepted by Hermes; Haskell is left out because 41 of its patterns
 * cannot be converted, and C++ because its grammar alone is about 730 KB.
 */

type GrammarModule = { readonly default: ReadonlyArray<LanguageRegistration> };

/** Each grammar loads the first time a block in that language is drawn. */
const GRAMMARS: Readonly<Record<string, () => Promise<GrammarModule>>> = {
  c: () => import("@shikijs/langs/c"),
  csharp: () => import("@shikijs/langs/csharp"),
  css: () => import("@shikijs/langs/css"),
  dart: () => import("@shikijs/langs/dart"),
  diff: () => import("@shikijs/langs/diff"),
  docker: () => import("@shikijs/langs/docker"),
  go: () => import("@shikijs/langs/go"),
  graphql: () => import("@shikijs/langs/graphql"),
  html: () => import("@shikijs/langs/html"),
  ini: () => import("@shikijs/langs/ini"),
  java: () => import("@shikijs/langs/java"),
  javascript: () => import("@shikijs/langs/javascript"),
  json: () => import("@shikijs/langs/json"),
  jsonc: () => import("@shikijs/langs/jsonc"),
  jsx: () => import("@shikijs/langs/jsx"),
  kotlin: () => import("@shikijs/langs/kotlin"),
  lua: () => import("@shikijs/langs/lua"),
  make: () => import("@shikijs/langs/make"),
  markdown: () => import("@shikijs/langs/markdown"),
  python: () => import("@shikijs/langs/python"),
  ruby: () => import("@shikijs/langs/ruby"),
  rust: () => import("@shikijs/langs/rust"),
  scss: () => import("@shikijs/langs/scss"),
  shellscript: () => import("@shikijs/langs/shellscript"),
  sql: () => import("@shikijs/langs/sql"),
  swift: () => import("@shikijs/langs/swift"),
  toml: () => import("@shikijs/langs/toml"),
  tsx: () => import("@shikijs/langs/tsx"),
  typescript: () => import("@shikijs/langs/typescript"),
  xml: () => import("@shikijs/langs/xml"),
  yaml: () => import("@shikijs/langs/yaml"),
};

/** The grammars the phone carries, by Shiki's name. */
export const HIGHLIGHTED_GRAMMARS: ReadonlyArray<string> = Object.keys(GRAMMARS);

/** What a fence tag or a file name may call a grammar, beside its own name. */
const ALIASES: Readonly<Record<string, string>> = {
  bash: "shellscript",
  cs: "csharp",
  dockerfile: "docker",
  golang: "go",
  h: "c",
  htm: "html",
  js: "javascript",
  kt: "kotlin",
  kts: "kotlin",
  makefile: "make",
  md: "markdown",
  mjs: "javascript",
  cjs: "javascript",
  mts: "typescript",
  cts: "typescript",
  patch: "diff",
  py: "python",
  rb: "ruby",
  rs: "rust",
  sh: "shellscript",
  shell: "shellscript",
  svg: "xml",
  ts: "typescript",
  yml: "yaml",
  zsh: "shellscript",
};

/** Files known by their whole name rather than an extension. */
const FILE_NAMES: Readonly<Record<string, string>> = {
  dockerfile: "docker",
  makefile: "make",
  gemfile: "ruby",
  rakefile: "ruby",
};

/**
 * Past this much code the block stays plain: tokenizing runs on the thread
 * that draws, and a long paste would hold up scrolling for longer than its
 * colours are worth.
 */
export const MAX_HIGHLIGHTED_CHARACTERS = 60_000;

/** The grammar a fence's language tag names, or undefined when there is none. */
export function grammarForFence(tag: string | undefined): string | undefined {
  if (tag === undefined) return undefined;
  const name = tag.trim().toLowerCase().split(/\s+/)[0] ?? "";
  return name in GRAMMARS ? name : ALIASES[name];
}

/** The grammar a file's path suggests, by its name or extension. */
export function grammarForPath(path: string): string | undefined {
  const base = (path.split("/").pop() ?? "").toLowerCase();
  const named = FILE_NAMES[base];
  if (named !== undefined) return named;
  const dot = base.lastIndexOf(".");
  return dot <= 0 ? undefined : grammarForFence(base.slice(dot + 1));
}

/** One coloured run of a line. `color` is absent where the theme leaves the ink. */
export interface CodeToken {
  readonly text: string;
  readonly color?: string;
  readonly italic?: boolean;
  readonly bold?: boolean;
}

export type CodeTokenLines = ReadonlyArray<ReadonlyArray<CodeToken>>;

export type CodeHighlight =
  | { readonly status: "highlighted"; readonly lines: CodeTokenLines }
  | { readonly status: "plain"; readonly reason: "no-grammar" | "too-long" | "failed" };

const THEMES = { light: "light-plus", dark: "dark-plus" } as const;

let highlighter: Promise<HighlighterCore> | undefined;
const grammarLoads = new Map<string, Promise<void>>();

function loadHighlighter(): Promise<HighlighterCore> {
  highlighter ??= (async () => {
    const [{ createHighlighterCore }, { createJavaScriptRegexEngine }] = await Promise.all([
      import("@shikijs/core"),
      import("@shikijs/engine-javascript"),
    ]);
    return createHighlighterCore({
      themes: [import("@shikijs/themes/light-plus"), import("@shikijs/themes/dark-plus")],
      langs: [],
      // A pattern Hermes cannot run is skipped rather than failing the block.
      engine: createJavaScriptRegexEngine({ target: "ES2018", forgiving: true }),
    });
  })();
  return highlighter;
}

async function ensureGrammar(core: HighlighterCore, grammar: string): Promise<void> {
  const load = GRAMMARS[grammar];
  if (load === undefined) return;
  let pending = grammarLoads.get(grammar);
  if (pending === undefined) {
    pending = load().then((module) => core.loadLanguage(...module.default));
    grammarLoads.set(grammar, pending);
  }
  await pending;
}

/**
 * A run in the theme's plain foreground carries no colour, so it takes the
 * block's own ink, which follows the app's palette and increased contrast.
 */
function toCodeToken(token: ThemedToken, foreground: string): CodeToken {
  // Shiki's font style is a bit set: 1 italic, 2 bold.
  const style = token.fontStyle ?? 0;
  const plain = token.color === undefined || token.color.toLowerCase() === foreground;
  return {
    text: token.content,
    ...(plain ? {} : { color: token.color }),
    ...((style & 1) === 0 ? {} : { italic: true }),
    ...((style & 2) === 0 ? {} : { bold: true }),
  };
}

/**
 * Colours `code` line by line for the light or dark scheme. Code in a
 * language with no grammar here, code past the length cap, and a grammar that
 * fails to load all come back plain, so the caller draws the text as it was.
 */
export async function highlightCode(
  code: string,
  grammar: string | undefined,
  scheme: "light" | "dark",
): Promise<CodeHighlight> {
  if (grammar === undefined || GRAMMARS[grammar] === undefined) {
    return { status: "plain", reason: "no-grammar" };
  }
  if (code.length > MAX_HIGHLIGHTED_CHARACTERS) return { status: "plain", reason: "too-long" };
  try {
    const core = await loadHighlighter();
    await ensureGrammar(core, grammar);
    const theme = THEMES[scheme];
    const foreground = core.getTheme(theme).fg.toLowerCase();
    const lines = core.codeToTokensBase(code, { lang: grammar, theme });
    return {
      status: "highlighted",
      lines: lines.map((line) => line.map((token) => toCodeToken(token, foreground))),
    };
  } catch {
    grammarLoads.delete(grammar);
    return { status: "plain", reason: "failed" };
  }
}

/** A diff row as the highlighter needs it: its kind, and its text with the mark. */
export interface DiffRowSource {
  readonly kind: "added" | "removed" | "context" | "hunk" | "meta";
  readonly text: string;
}

/**
 * The old and new files as far as a diff shows them, each as one text, and
 * which of their lines every row is. Removed rows read in the old file, added
 * and context rows in the new, so a comment or string that spans lines is
 * coloured as the file reads rather than one row at a time.
 */
export function diffSides(rows: ReadonlyArray<DiffRowSource>): {
  readonly oldCode: string;
  readonly newCode: string;
  readonly rowLines: ReadonlyArray<{ readonly side: "old" | "new"; readonly line: number } | null>;
} {
  const oldLines: string[] = [];
  const newLines: string[] = [];
  const rowLines = rows.map((row) => {
    if (row.kind === "hunk" || row.kind === "meta") return null;
    const text = row.text.slice(1);
    if (row.kind === "removed") {
      oldLines.push(text);
      return { side: "old" as const, line: oldLines.length - 1 };
    }
    if (row.kind === "context") oldLines.push(text);
    newLines.push(text);
    return { side: "new" as const, line: newLines.length - 1 };
  });
  return { oldCode: oldLines.join("\n"), newCode: newLines.join("\n"), rowLines };
}
