import { lazy, Suspense } from "react";
import { File } from "../ui/icons";

const fileGlyph = <File className="shrink-0" size={12} />;
const FileTypeGlyph = lazy(() =>
  import("./ComposerAttachmentGlyph").catch(() => ({ default: () => fileGlyph })),
);

export function ComposerAttachmentIcon({ name }: { readonly name: string }) {
  return (
    <Suspense fallback={fileGlyph}>
      <FileTypeGlyph name={name} />
    </Suspense>
  );
}
