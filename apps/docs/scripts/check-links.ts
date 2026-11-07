import { readdir, readFile } from "node:fs/promises";
import { extname, join, normalize, relative, resolve } from "node:path/posix";
import { fileURLToPath } from "node:url";

export interface SourceFile {
  readonly path: string;
  readonly content: string;
}

export interface LinkIssue {
  readonly file: string;
  readonly target: string;
}

const EXTERNAL = /^(?:https?|mailto|tel):/i;
const MARKDOWN_LINK = /\[[^\]]*\]\(([^)\s)]+)\)/g;
const CONFIG_LINK = /link:\s*["']([^"']+)["']/g;

function stripFragment(target: string): string {
  const hash = target.indexOf("#");
  return hash === -1 ? target : target.slice(0, hash);
}

function fragmentOf(target: string): string {
  const hash = target.indexOf("#");
  return hash === -1 ? "" : target.slice(hash + 1);
}

/** VitePress heading slugs: lowercase, punctuation/symbol runs collapse to one hyphen. */
export function slugifyHeading(text: string): string {
  return text
    .replace(/\[([^\]]*)\]\([^)]*\)/g, (_m, label: string) => label)
    .replace(/[`*_[\]]/g, "")
    .toLowerCase()
    .trim()
    .replace(/[\s\p{P}\p{S}]+/gu, "-");
}

/** Heading slugs of one Markdown page, in order; fenced code blocks are not headings. */
export function headingSlugs(content: string): string[] {
  const withoutFences = content.replace(/```[\s\S]*?```/g, "");
  const slugs: string[] = [];
  for (const match of withoutFences.matchAll(/^#{1,6}\s+(.+)$/gm)) {
    slugs.push(slugifyHeading(match[1] ?? ""));
  }
  return slugs;
}

function candidatesFor(rel: string): string[] {
  const trimmed = rel.replace(/^\/+/, "");
  if (trimmed === "") return ["index.md"];
  if (trimmed.endsWith("/")) return [`${trimmed}index.md`];
  if (trimmed.endsWith(".md") || extname(trimmed) !== "") return [trimmed];
  return [trimmed, `${trimmed}.md`, `${trimmed}/index.md`];
}

function baseDirFor(path: string): string {
  const idx = path.lastIndexOf("/");
  return idx === -1 ? "." : path.slice(0, idx);
}

function extractLinks(file: SourceFile): string[] {
  const links: string[] = [];
  if (file.path.endsWith(".md")) {
    for (const match of file.content.matchAll(MARKDOWN_LINK)) {
      const target = match[1]?.trim() ?? "";
      if (target && !EXTERNAL.test(target)) links.push(target);
    }
  } else {
    for (const match of file.content.matchAll(CONFIG_LINK)) {
      const target = match[1]?.trim() ?? "";
      if (target && !EXTERNAL.test(target)) links.push(target);
    }
  }
  return links;
}

export interface AnchorIssue {
  readonly file: string;
  readonly target: string;
  readonly anchor: string;
}

export function checkLinks(sources: ReadonlyArray<SourceFile>): LinkIssue[] {
  const existing = new Set(sources.map((file) => normalize(file.path.replace(/^\/+/, ""))));

  const issues: LinkIssue[] = [];
  for (const file of sources) {
    const relativeBase = baseDirFor(normalize(file.path));
    for (const rawTarget of extractLinks(file)) {
      if (rawTarget.startsWith("#")) continue;
      const target = stripFragment(rawTarget);
      const rel = target.startsWith("/") ? target.slice(1) : normalize(join(relativeBase, target));
      const resolves = candidatesFor(rel).some((candidate) => existing.has(candidate));
      if (!resolves) issues.push({ file: file.path, target: rawTarget });
    }
  }
  return issues;
}

/**
 * Every in-site `#anchor` must exist as a heading slug on its target page.
 * External links and config links carry no fragments to check.
 */
export function checkAnchors(sources: ReadonlyArray<SourceFile>): AnchorIssue[] {
  const pages = new Map(
    sources
      .filter((file) => file.path.endsWith(".md"))
      .map((file) => [normalize(file.path.replace(/^\/+/, "")), headingSlugs(file.content)]),
  );
  const existing = new Set(pages.keys());

  const issues: AnchorIssue[] = [];
  for (const file of pages.keys()) {
    const content =
      sources.find((source) => normalize(source.path.replace(/^\/+/, "")) === file)?.content ?? "";
    const relativeBase = baseDirFor(file);
    for (const rawTarget of extractLinks({ path: file, content })) {
      const anchor = fragmentOf(rawTarget);
      if (anchor === "") continue;
      const target = stripFragment(rawTarget);
      const rel =
        target === ""
          ? file
          : target.startsWith("/")
            ? target.slice(1)
            : normalize(join(relativeBase, target));
      const page = candidatesFor(rel).find((candidate) => existing.has(candidate));
      if (page === undefined) continue; // already reported by checkLinks
      if (!pages.get(page)?.includes(anchor)) {
        issues.push({ file, target: rawTarget, anchor });
      }
    }
  }
  return issues;
}

async function collectMarkdown(root: string, directory: string): Promise<SourceFile[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry): Promise<SourceFile[]> => {
      const absolute = join(directory, entry.name);
      const path = relative(root, absolute);
      if (entry.isDirectory()) return collectMarkdown(root, absolute);
      if (!entry.name.endsWith(".md")) return [];
      return [{ path, content: await readFile(absolute, "utf8") }];
    }),
  );
  return nested.flat();
}

async function collectSources(docsRoot: string): Promise<SourceFile[]> {
  const markdown = await collectMarkdown(docsRoot, docsRoot);
  const configPath = join(docsRoot, ".vitepress", "config.ts");
  const config: SourceFile = {
    path: relative(docsRoot, configPath),
    content: await readFile(configPath, "utf8"),
  };
  return [...markdown, config];
}

async function main(): Promise<void> {
  const docsRoot = resolve(fileURLToPath(new URL("../", import.meta.url)));
  const sources = await collectSources(docsRoot);
  const issues = checkLinks(sources);
  for (const issue of issues) {
    console.error(`${issue.file}: unresolved link target ${issue.target}`);
  }
  for (const issue of checkAnchors(sources)) {
    console.error(`${issue.file}: no heading "#${issue.anchor}" on ${issue.target}`);
    issues.push({ file: issue.file, target: issue.target });
  }
  if (issues.length !== 0) process.exitCode = 1;
}

if (import.meta.main) await main();
