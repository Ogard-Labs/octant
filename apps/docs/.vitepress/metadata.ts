export const DEFAULT_DOCS_SITE_URL = "https://octant.dev/docs/";
export const DEFAULT_DOCS_DESCRIPTION =
  "The official Octant guide for working with Chat, Work, and Code.";

export interface PageMetadataInput {
  readonly relativePath: string;
  readonly title: string;
  readonly description: string;
  readonly siteUrl: string;
}

export type MetadataHeadEntry = [string, Record<string, string>];

export function normalizeDocsSiteUrl(value: string): string {
  const candidate = value.trim();
  if (candidate.length === 0) throw new Error("Documentation site URL must be an absolute URL.");

  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    throw new Error("Documentation site URL must be an absolute URL.");
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Documentation site URL must use HTTP or HTTPS.");
  }

  url.search = "";
  url.hash = "";
  if (!url.pathname.endsWith("/")) url.pathname += "/";
  return url.toString();
}

export function pageUrlFor(relativePath: string, siteUrl: string): string {
  const baseUrl = normalizeDocsSiteUrl(siteUrl);
  const sourcePath = relativePath.replaceAll("\\", "/").replace(/^\/+/, "");
  const route =
    sourcePath === "" || sourcePath === "index.md"
      ? ""
      : sourcePath.endsWith("/index.md")
        ? sourcePath.slice(0, -"index.md".length)
        : sourcePath.endsWith(".md")
          ? sourcePath.slice(0, -".md".length)
          : sourcePath;

  return new URL(route, baseUrl).toString();
}

export function createPageHead(input: PageMetadataInput): MetadataHeadEntry[] {
  const canonicalUrl = pageUrlFor(input.relativePath, input.siteUrl);
  const pageTitle = input.title.trim();
  const title =
    pageTitle.length === 0
      ? "Octant Docs"
      : pageTitle.endsWith(" | Octant Docs")
        ? pageTitle
        : `${pageTitle} | Octant Docs`;

  return [
    ["link", { rel: "canonical", href: canonicalUrl }],
    ["meta", { property: "og:type", content: "website" }],
    ["meta", { property: "og:title", content: title }],
    ["meta", { property: "og:description", content: input.description }],
    ["meta", { property: "og:url", content: canonicalUrl }],
  ];
}
