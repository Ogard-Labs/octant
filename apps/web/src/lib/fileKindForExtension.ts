const CODE_EXTENSIONS = new Set([
  "c",
  "cc",
  "cjs",
  "cpp",
  "cs",
  "css",
  "go",
  "h",
  "html",
  "java",
  "js",
  "json",
  "jsx",
  "kt",
  "mjs",
  "py",
  "rb",
  "rs",
  "scss",
  "sh",
  "sql",
  "swift",
  "toml",
  "ts",
  "tsx",
  "xml",
  "yaml",
  "yml",
]);
const DOCUMENT_EXTENSIONS = new Set(["md", "mdx", "rst", "txt"]);
const IMAGE_EXTENSIONS = new Set(["avif", "gif", "ico", "jpeg", "jpg", "png", "svg", "webp"]);

export function fileKindForExtension(extension: string): "code" | "document" | "image" | "file" {
  if (CODE_EXTENSIONS.has(extension)) return "code";
  if (DOCUMENT_EXTENSIONS.has(extension)) return "document";
  if (IMAGE_EXTENSIONS.has(extension)) return "image";
  return "file";
}
