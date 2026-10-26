import * as DocumentPicker from "expo-document-picker";
import { File, Paths } from "expo-file-system";
import * as ImagePicker from "expo-image-picker";
import type { MobileAttachmentSource } from "@octant/client-runtime";
import { acceptedMediaType } from "./imageBytes";

export type PickedAttachment =
  | { readonly status: "denied"; readonly source: "camera" | "library" }
  | { readonly status: "canceled" }
  | { readonly status: "unsupported" }
  | {
      readonly status: "picked";
      readonly uri: string;
      readonly fileName: string | undefined;
      readonly mediaType: string;
    };

/**
 * Asks the person for one attachment from the source they chose, and only
 * then for that source's permission. Nothing here runs except on their tap.
 * The library hands back a compatible JPEG rather than HEIC, a type no thread
 * takes; camera and library ask for no EXIF, though the host removes it anyway.
 */
export async function pickAttachment(
  source: MobileAttachmentSource,
  accepted: ReadonlyArray<string>,
): Promise<PickedAttachment> {
  if (source === "file") {
    const picked = await DocumentPicker.getDocumentAsync({
      type: [...accepted],
      copyToCacheDirectory: true,
      multiple: false,
    });
    const asset = picked.canceled ? undefined : picked.assets[0];
    if (asset === undefined) return { status: "canceled" };
    return pickedAsset(asset.uri, asset.name, asset.mimeType, accepted);
  }
  const permission =
    source === "camera"
      ? await ImagePicker.requestCameraPermissionsAsync()
      : await ImagePicker.requestMediaLibraryPermissionsAsync();
  if (!permission.granted) return { status: "denied", source };
  const options: ImagePicker.ImagePickerOptions = {
    mediaTypes: ["images"],
    quality: 0.85,
    exif: false,
  };
  const picked =
    source === "camera"
      ? await ImagePicker.launchCameraAsync(options)
      : await ImagePicker.launchImageLibraryAsync({
          ...options,
          preferredAssetRepresentationMode:
            ImagePicker.UIImagePickerPreferredAssetRepresentationMode.Compatible,
        });
  const asset = picked.canceled ? undefined : picked.assets[0];
  if (asset === undefined) return { status: "canceled" };
  return pickedAsset(asset.uri, asset.fileName ?? asset.uri, asset.mimeType, accepted);
}

function pickedAsset(
  uri: string,
  name: string,
  reported: string | null | undefined,
  accepted: ReadonlyArray<string>,
): PickedAttachment {
  const mediaType = acceptedMediaType({ reported, name, accepted });
  if (mediaType === undefined) {
    discardPickedCopy(uri);
    return { status: "unsupported" };
  }
  const fileName = name === uri ? undefined : name.trim() || undefined;
  return { status: "picked", uri, fileName, mediaType };
}

/**
 * The camera and the pickers leave their copy in the app's cache. The phone
 * keeps no copy beyond the upload, so that copy is deleted once the upload
 * ends, whichever way it ended. A file outside the cache is not the app's own
 * and is left alone.
 */
export function discardPickedCopy(uri: string): void {
  try {
    if (!uri.startsWith(Paths.cache.uri)) return;
    const file = new File(uri);
    if (file.exists) file.delete();
  } catch {
    // The web build has no app cache to clear.
  }
}
