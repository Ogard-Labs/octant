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
      if (target && !target.startsWith("#") && !EXTERNAL.test(target)) links.push(target);
    }
  } else {
    for (const match of file.content.matchAll(CONFIG_LINK)) {
      const target = match[1]?.trim() ?? "";
      if (target && !target.startsWith("#") && !EXTERNAL.test(target)) links.push(target);
    }
  }
  return links;
}

export function checkLinks(sources: ReadonlyArray<SourceFile>): LinkIssue[] {
  const existing = new Set(sources.map((file) => normalize(file.path.replace(/^\/+/, ""))));

  const issues: LinkIssue[] = [];
  for (const file of sources) {
    const relativeBase = baseDirFor(normalize(file.path));
    for (const rawTarget of extractLinks(file)) {
      const target = stripFragment(rawTarget);
      const rel = target.startsWith("/") ? target.slice(1) : normalize(join(relativeBase, target));
      const resolves = candidatesFor(rel).some((candidate) => existing.has(candidate));
      if (!resolves) issues.push({ file: file.path, target: rawTarget });
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
  if (issues.length === 0) return;
  for (const issue of issues) {
    console.error(`${issue.file}: unresolved link target ${issue.target}`);
  }
  process.exitCode = 1;
}

if (import.meta.main) await main();
