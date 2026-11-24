import type { PreparedComposerStash } from "./useComposerStash";

type StagedFile<Entry> =
  | { readonly kind: "staged"; readonly entry: Entry }
  | Extract<PreparedComposerStash, { readonly kind: "refused" }>;

/** Stage replacements independently, so a refused file or move leaves the current chips intact. */
export async function prepareComposerStashFiles<Entry extends { readonly file: File }>(input: {
  readonly current: ReadonlyArray<Entry>;
  readonly files: ReadonlyArray<File>;
  readonly stage: (file: File) => Promise<StagedFile<Entry>>;
  readonly discard: (entry: Entry) => void;
  readonly apply: (entries: ReadonlyArray<Entry>) => void;
}): Promise<PreparedComposerStash> {
  const unused = [...input.current];
  const created: Entry[] = [];
  const staged: Entry[] = [];
  const release = () => {
    for (const entry of created) input.discard(entry);
  };
  for (const file of input.files) {
    const index = unused.findIndex((entry) => entry.file === file);
    const existing = unused[index];
    if (existing !== undefined) {
      unused.splice(index, 1);
      staged.push(existing);
      continue;
    }
    try {
      const result = await input.stage(file);
      if (result.kind === "refused") {
        release();
        return result;
      }
      created.push(result.entry);
      staged.push(result.entry);
    } catch {
      release();
      return { kind: "refused", reason: `${file.name || "An attachment"} could not be restored.` };
    }
  }
  return {
    kind: "ready",
    release,
    apply: () => {
      input.apply(staged);
      for (const entry of unused) input.discard(entry);
    },
  };
}
