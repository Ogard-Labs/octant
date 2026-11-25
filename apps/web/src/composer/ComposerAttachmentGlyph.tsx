import { Archive, CodeXml, File, FileSpreadsheet, FileText, Image } from "../ui/icons";
import { fileKindForExtension } from "../lib/fileKindForExtension";

const fileKindIcons = { code: CodeXml, document: FileText, image: Image };
const attachmentFormatIcons = [
  {
    icon: FileText,
    extensions: ["markdown", "rtf", "pdf", "doc", "docx", "odt", "ppt", "pptx"],
  },
  { icon: CodeXml, extensions: ["php"] },
  { icon: FileSpreadsheet, extensions: ["csv", "ods", "tsv", "xls", "xlsx"] },
  { icon: Archive, extensions: ["7z", "bz2", "gz", "rar", "tar", "xz", "zip"] },
  {
    icon: Image,
    extensions: ["bmp", "heic", "tif", "tiff"],
  },
];

export default function ComposerAttachmentGlyph({ name }: { readonly name: string }) {
  const extension = name.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? "";
  const kind = fileKindForExtension(extension);
  const Icon =
    kind === "file"
      ? (attachmentFormatIcons.find(({ extensions }) => extensions.includes(extension))?.icon ??
        File)
      : fileKindIcons[kind];
  return <Icon className="shrink-0" size={12} />;
}
