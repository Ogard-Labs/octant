import { Archive, CodeXml, File, FileSpreadsheet, FileText, Image } from "../ui/icons";

const fileTypeIcons = [
  {
    icon: FileText,
    extensions: ["md", "mdx", "markdown", "txt", "rtf", "pdf", "doc", "docx", "odt", "ppt", "pptx"],
  },
  {
    icon: CodeXml,
    extensions: [
      "c",
      "cpp",
      "css",
      "go",
      "html",
      "java",
      "js",
      "json",
      "jsx",
      "kt",
      "mjs",
      "php",
      "py",
      "rb",
      "rs",
      "sh",
      "sql",
      "swift",
      "toml",
      "ts",
      "tsx",
      "xml",
      "yaml",
      "yml",
    ],
  },
  { icon: FileSpreadsheet, extensions: ["csv", "ods", "tsv", "xls", "xlsx"] },
  { icon: Archive, extensions: ["7z", "bz2", "gz", "rar", "tar", "xz", "zip"] },
  {
    icon: Image,
    extensions: ["avif", "bmp", "gif", "heic", "jpeg", "jpg", "png", "svg", "tif", "tiff", "webp"],
  },
];

export function ComposerAttachmentIcon({ name }: { readonly name: string }) {
  const extension = name.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? "";
  const Icon = fileTypeIcons.find(({ extensions }) => extensions.includes(extension))?.icon ?? File;
  return <Icon className="composer-file-chip__icon" size={12} />;
}
