import { readdir, readFile } from "node:fs/promises";
import { join, normalize, relative, resolve } from "node:path/posix";
import { fileURLToPath } from "node:url";

/**
 * Sidebar coverage gate: every Markdown page in the guide must be reachable
 * from the VitePress sidebar (or be listed in SIDEBAR_EXEMPT with a reason).
 * A page that exists but is in no sidebar entry is invisible in the nav —
 * found 2026-11-07 with Work Thread Board and Google Workspace unlisted.
 */

export interface SourceFile {
  readonly path: string;
  readonly content: string;
}

export interface SidebarIssue {
  readonly page: string;
  readonly route: string;
}

/** Pages deliberately not in the sidebar, with the reason. */
export const SIDEBAR_EXEMPT: Readonly<Record<string, string>> = {
  // The home page is the hero, not a sidebar entry.
  "index.md": "home page",
};

const CONFIG_LINK = /link:\s*["']([^"']+)["']/g;

/** The route a Markdown page builds to (cleanUrls): `guide/export.md` -> `/guide/export`. */
export function routeFor(path: string): string {
  const normalized = normalize(path.replace(/^\/+/, ""));
  const withoutMd = normalized.endsWith(".md") ? normalized.slice(0, -".md".length) : normalized;
  if (withoutMd === "index") return "/";
  return withoutMd.endsWith("/index")
    ? `/${withoutMd.slice(0, -"/index".length)}/`
    : `/${withoutMd}`;
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

export function checkSidebar(sources: ReadonlyArray<SourceFile>, config: string): SidebarIssue[] {
  const sidebarRoutes = new Set<string>();
  for (const match of config.matchAll(CONFIG_LINK)) {
    const target = match[1]?.trim() ?? "";
    // sidebar links are already route form: "/guide/" for a section, "/guide/export" for a page
    if (target.startsWith("/")) sidebarRoutes.add(target);
  }

  const issues: SidebarIssue[] = [];
  for (const file of sources) {
    if (SIDEBAR_EXEMPT[file.path] !== undefined) continue;
    const route = routeFor(file.path);
    if (!sidebarRoutes.has(route)) {
      issues.push({ page: file.path, route });
    }
  }
  return issues;
}

async function main(): Promise<void> {
  const docsRoot = resolve(fileURLToPath(new URL("../", import.meta.url)));
  const sources = await collectMarkdown(docsRoot, docsRoot);
  const config = await readFile(join(docsRoot, ".vitepress", "config.ts"), "utf8");
  const issues = checkSidebar(sources, config);
  for (const issue of issues) {
    console.error(`${issue.page}: builds to ${issue.route} but no sidebar entry links there`);
  }
  if (issues.length !== 0) process.exitCode = 1;
}

if (import.meta.main) await main();
