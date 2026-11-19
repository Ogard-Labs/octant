import * as DocumentPicker from "expo-document-picker";
import { File } from "expo-file-system";
import { CANVAS_HTML_IMPORT_MAX_BYTES } from "@octant/contracts";
import { discardPickedCopy } from "../inbox/thread/pickAttachment";

export type PickedHtmlPage =
  | { readonly status: "canceled" }
  | { readonly status: "too-large" }
  | { readonly status: "picked"; readonly html: string; readonly fileName: string | undefined };

/**
 * Asks the person for one HTML file and reads it. A file past the import's
 * bound is not read at all: the host would refuse it the same way. The
 * picker's cache copy is deleted once read, as an attachment's is.
 */
export async function pickHtmlPage(): Promise<PickedHtmlPage> {
  const picked = await DocumentPicker.getDocumentAsync({
    type: ["text/html", "application/xhtml+xml"],
    copyToCacheDirectory: true,
    multiple: false,
  });
  const asset = picked.canceled ? undefined : picked.assets[0];
  if (asset === undefined) return { status: "canceled" };
  try {
    if (asset.size !== undefined && asset.size > CANVAS_HTML_IMPORT_MAX_BYTES) {
      return { status: "too-large" };
    }
    // The web build hands back the browser's own File; a phone, a cache copy.
    const html =
      asset.file === undefined ? await new File(asset.uri).text() : await asset.file.text();
    return { status: "picked", html, fileName: asset.name.trim() || undefined };
  } finally {
    discardPickedCopy(asset.uri);
  }
}
