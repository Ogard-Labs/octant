import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { relative, sep } from "node:path";
import { Schema } from "effect";
import {
  CodeDigest,
  decodeCodeProjectFilePath,
  type CodeThreadId,
  type CodeCheckoutId,
} from "@octant/contracts";
import { CodeLanguageRange, type CodeLanguageEditFile } from "@octant/contracts/code-language";
import { classifyPathContainment } from "@octant/domain";
import type { CodeTestSourcePort } from "./codeDirectoryPort";
import { readConfinedCodeFile } from "./codeConfinedFileRead";
import { resolveContainedPath } from "./codePathConfinement";
import { deriveCodeFileId } from "./codeFileIdentity";

type Failure = {
  readonly status: "refused";
  readonly reason: "unsafe-edit" | "unsaved-edits" | "invalid-edit" | "too-large";
};
const invalid: Failure = { status: "refused", reason: "invalid-edit" };
const unsafe: Failure = { status: "refused", reason: "unsafe-edit" };
const large: Failure = { status: "refused", reason: "too-large" };
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Server edits are suggestions: resource operations and commands never become executable authority. */
export async function languageEditPreview(input: {
  readonly result: unknown;
  readonly root: string;
  readonly extraFolder?: boolean;
  readonly threadId: CodeThreadId;
  readonly checkoutId: CodeCheckoutId;
  readonly port: CodeTestSourcePort;
  readonly openText: (uri: string) => string | undefined;
  readonly openVersion?: (uri: string) => number | undefined;
  readonly current: () => boolean;
}): Promise<
  Failure | { readonly status: "preview"; readonly files: ReadonlyArray<CodeLanguageEditFile> }
> {
  if (!record(input.result)) return invalid;
  const entries: Array<{ readonly uri: string; readonly edits: unknown }> = [];
  if (input.result.changes !== undefined) {
    if (!record(input.result.changes) || input.result.documentChanges !== undefined) return invalid;
    for (const [uri, edits] of Object.entries(input.result.changes)) entries.push({ uri, edits });
  } else if (Array.isArray(input.result.documentChanges)) {
    for (const change of input.result.documentChanges) {
      if (
        !record(change) ||
        "kind" in change ||
        !record(change.textDocument) ||
        typeof change.textDocument.uri !== "string"
      )
        return unsafe;
      // Numeric protocol versions cannot prove the saved-file snapshot this preview applies to.
      if (
        change.textDocument.version !== undefined &&
        change.textDocument.version !== null &&
        change.textDocument.version !== input.openVersion?.(change.textDocument.uri)
      )
        return invalid;
      entries.push({ uri: change.textDocument.uri, edits: change.edits });
    }
  } else return invalid;
  if (entries.length > 16) return large;
  if (new Set(entries.map((entry) => entry.uri)).size !== entries.length) return invalid;
  const files: CodeLanguageEditFile[] = [];
  let total = 0;
  for (const entry of entries) {
    if (!input.current()) return invalid;
    if (!Array.isArray(entry.edits) || entry.edits.length > 256) return large;
    let absolute: string;
    try {
      const uri = new URL(entry.uri);
      if (uri.protocol !== "file:" || uri.host !== "") return unsafe;
      absolute = fileURLToPath(uri);
    } catch {
      return unsafe;
    }
    if (classifyPathContainment(input.root, absolute) !== "contained") return unsafe;
    const confined = await resolveContainedPath(input.port, input.root, absolute);
    if (confined === undefined) return unsafe;
    // An alias would write a different name than the one reviewed; refuse it rather than resolve silently.
    if (confined.canonical !== absolute) return unsafe;
    const local = decodeCodeProjectFilePath(relative(input.root, absolute).split(sep).join("/"));
    const read = await readConfinedCodeFile({
      port: input.port,
      canonicalRoot: input.root,
      relativePath: local,
      maximumBytes: 256 * 1024,
    });
    if (read.status !== "read") return unsafe;
    let before: string;
    try {
      before = new TextDecoder("utf-8", { fatal: true }).decode(read.bytes);
    } catch {
      return invalid;
    }
    const open = input.openText(entry.uri);
    if (open !== undefined && open !== before)
      return { status: "refused", reason: "unsaved-edits" };
    const lines = before.split("\n");
    const offset = (line: number, character: number): number | undefined => {
      const text = lines[line];
      if (text === undefined || character > text.replace(/\r$/, "").length) return undefined;
      let value = character;
      for (let index = 0; index < line; index++) value += (lines[index]?.length ?? 0) + 1;
      return value;
    };
    const edits: Array<{ start: number; end: number; text: string }> = [];
    for (const edit of entry.edits) {
      if (
        !record(edit) ||
        typeof edit.newText !== "string" ||
        edit.newText.length > 256 * 1024 ||
        "annotationId" in edit
      )
        return invalid;
      const parsed = Schema.decodeUnknownEither(CodeLanguageRange)(edit.range);
      if (parsed._tag === "Left") return invalid;
      const start = offset(parsed.right.start.line, parsed.right.start.character);
      const end = offset(parsed.right.end.line, parsed.right.end.character);
      if (start === undefined || end === undefined) return invalid;
      edits.push({ start, end, text: edit.newText });
    }
    edits.sort((left, right) => right.start - left.start || right.end - left.end);
    let after = before;
    let limit = before.length + 1;
    for (const edit of edits) {
      if (edit.end > limit || (edit.start === limit && edit.end === limit)) return invalid;
      after = after.slice(0, edit.start) + edit.text + after.slice(edit.end);
      limit = edit.start;
    }
    total += before.length + after.length;
    if (after.length > 256 * 1024 || total > 1024 * 1024) return large;
    const path = input.extraFolder ? decodeCodeProjectFilePath(absolute) : local;
    files.push({
      path,
      fileId: deriveCodeFileId(String(input.threadId), String(input.checkoutId), path),
      identity: { device: confined.stat.device, inode: confined.stat.inode },
      digest: Schema.decodeUnknownSync(CodeDigest)(
        createHash("sha256").update(read.bytes).digest("hex"),
      ),
      before,
      after,
    });
  }
  return input.current() ? { status: "preview", files } : invalid;
}
