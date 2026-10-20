import * as ImagePicker from "expo-image-picker";
import { IMAGE_MEDIA_TYPES, guessImageMediaType } from "./imageBytes";

export type PickedImage =
  | { readonly status: "denied" }
  | { readonly status: "canceled" }
  | { readonly status: "unsupported" }
  | {
      readonly status: "picked";
      readonly uri: string;
      readonly fileName: string | undefined;
      readonly mediaType: string;
    };

export async function pickImage(): Promise<PickedImage> {
  const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
  if (!permission.granted) return { status: "denied" };
  const picked = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ["images"],
    quality: 0.9,
  });
  const asset = picked.canceled ? undefined : picked.assets[0];
  if (asset === undefined) return { status: "canceled" };
  const mediaType = guessImageMediaType(asset.uri, asset.mimeType);
  if (!IMAGE_MEDIA_TYPES.has(mediaType)) return { status: "unsupported" };
  return {
    status: "picked",
    uri: asset.uri,
    fileName: asset.fileName?.trim() || undefined,
    mediaType,
  };
}
