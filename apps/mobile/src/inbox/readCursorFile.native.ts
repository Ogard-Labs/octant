import { File, Paths } from "expo-file-system";

// Thread ids and positions, no titles or text, so it needs no keychain entry.
const kept = () => new File(Paths.document, "thread-read-cursors.v1.json");

export function loadReadCursors(): string | null {
  try {
    const file = kept();
    return file.exists ? file.textSync() : null;
  } catch {
    return null;
  }
}

export function keepReadCursors(text: string): void {
  try {
    const file = kept();
    if (!file.exists) file.create();
    file.writeSync(text);
  } catch {
    // The count starts over next time.
  }
}
