import { defineConfig } from "vitepress";
import {
  DEFAULT_DOCS_DESCRIPTION,
  DEFAULT_DOCS_SITE_URL,
  createPageHead,
  normalizeDocsSiteUrl,
} from "./metadata";
import { SEMANTIC_TOKEN_CSS } from "./theme/semanticTokens";

function normalizeBase(value: string): string {
  const candidate = value.trim();
  if (!candidate.startsWith("/")) throw new Error("Documentation base must start with '/'.");
  if (candidate.includes("?") || candidate.includes("#")) {
    throw new Error("Documentation base cannot contain a query or hash.");
  }
  return candidate.endsWith("/") ? candidate : `${candidate}/`;
}

const base = normalizeBase(process.env.OCTANT_DOCS_BASE ?? "/");
const siteUrl = normalizeDocsSiteUrl(process.env.OCTANT_DOCS_URL ?? DEFAULT_DOCS_SITE_URL);

export default defineConfig({
  lang: "en-US",
  title: "Octant Docs",
  titleTemplate: ":title | Octant Docs",
  description: DEFAULT_DOCS_DESCRIPTION,
  base,
  cleanUrls: true,
  outDir: "./dist",
  cacheDir: "./.vitepress/cache",
  vite: {
    esbuild: { target: "es2022" },
  },
  sitemap: { hostname: siteUrl },
  head: [
    ["meta", { name: "theme-color", content: "#101117" }],
    ["meta", { property: "og:site_name", content: "Octant" }],
    ["meta", { name: "twitter:card", content: "summary" }],
    ["style", {}, SEMANTIC_TOKEN_CSS],
  ],
  themeConfig: {
    nav: [
      { text: "Guide", link: "/guide/" },
      { text: "Concepts", link: "/concepts/" },
      { text: "Advanced", link: "/advanced/" },
    ],
    sidebar: {
      "/guide/": [
        {
          text: "Getting Started",
          items: [
            { text: "Overview", link: "/guide/" },
            { text: "Installation", link: "/guide/installation" },
            { text: "First Run", link: "/guide/first-run" },
          ],
        },
        {
          text: "Modes",
          items: [
            { text: "Chat", link: "/guide/chat" },
            { text: "Work", link: "/guide/work" },
            { text: "Code", link: "/guide/code" },
          ],
        },
        {
          text: "Projects And Context",
          items: [
            { text: "Projects", link: "/guide/projects" },
            { text: "Shared Memory", link: "/guide/memory" },
            { text: "Promotions", link: "/guide/promotions" },
          ],
        },
      ],
      "/concepts/": [
        {
          text: "Concepts",
          items: [{ text: "Modes", link: "/concepts/" }],
        },
      ],
      "/advanced/": [
        {
          text: "Advanced",
          items: [
            { text: "Overview", link: "/advanced/" },
            { text: "Providers and Models", link: "/advanced/providers" },
            { text: "Context Budgets", link: "/advanced/context-budgets" },
            { text: "Subagents", link: "/advanced/subagents" },
            { text: "Plugins and Skills", link: "/advanced/plugins-and-skills" },
          ],
        },
        {
          text: "Workspaces",
          items: [
            { text: "Files and Previews", link: "/advanced/files" },
            { text: "Editor and Terminals", link: "/advanced/editor-and-terminals" },
            { text: "Git and Worktrees", link: "/advanced/git-worktrees" },
            { text: "Code Thread Board", link: "/advanced/code-board" },
            { text: "Browser and Computer Use", link: "/advanced/browser-and-computer-use" },
            { text: "Apple Workbench", link: "/advanced/apple-workbench" },
          ],
        },
        {
          text: "Operations",
          items: [
            { text: "Keyboard Workflows", link: "/advanced/keyboard-workflows" },
            { text: "Themes and Appearance", link: "/advanced/themes" },
            { text: "Privacy and Security", link: "/advanced/privacy-and-security" },
            { text: "Privacy Notice", link: "/advanced/privacy-notice" },
            { text: "Sub-processors", link: "/advanced/sub-processors" },
            { text: "Data Residency", link: "/advanced/data-residency" },
            { text: "DPA Template", link: "/advanced/dpa-template" },
            { text: "SCC Position", link: "/advanced/scc-position" },
            { text: "EULA Placeholders", link: "/advanced/eula-placeholders" },
            { text: "Remote Access", link: "/advanced/remote-access" },
            { text: "Recovery", link: "/advanced/recovery" },
            { text: "Release Compatibility", link: "/advanced/release-compatibility" },
          ],
        },
      ],
    },
    search: { provider: "local" },
    outline: [2, 3],
    footer: {
      message: "Octant documentation · local-first by design",
    },
  },
  transformPageData(pageData) {
    pageData.frontmatter.head ??= [];
    pageData.frontmatter.head.push(
      ...createPageHead({
        relativePath: pageData.relativePath,
        title: pageData.title,
        description: pageData.description || DEFAULT_DOCS_DESCRIPTION,
        siteUrl,
      }),
    );
  },
});
