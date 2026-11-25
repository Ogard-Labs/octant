import { requireOptionalNativeModule } from "expo";
import { Directory, type File } from "expo-file-system";
import { Platform } from "react-native";

interface OctantVideoSave {
  pick(): Promise<string | null>;
  copy(selection: string, clipUri: string): Promise<void>;
  discard(selection: string): Promise<void>;
}

export async function saveVideoClip(file: File, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return false;
  if (Platform.OS === "ios") {
    const native = requireOptionalNativeModule<OctantVideoSave>("OctantVideoSave");
    if (!native) throw new Error("Video saving requires the native Octant app.");
    const selection = await native.pick();
    if (selection === null) return false;
    try {
      if (signal.aborted) return false;
      await native.copy(selection, file.uri);
      return true;
    } finally {
      await native.discard(selection);
    }
  }

  const directory = await Directory.pickDirectoryAsync();
  // Access can change while the person is choosing a folder.
  if (signal.aborted) return false;
  await file.copy(directory, { overwrite: false });
  return true;
}
