import type { CodeClient, CodeFileOpenResult } from "@octant/client-runtime/code-client";
import type { CodeRelativePath, CodeThread } from "@octant/contracts/code";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CodeEditorFileProjection } from "./MonacoEditorPane";
import type { CodeController } from "./useCodeController";

/**
 * Open the tab's file through the host and project the strict open envelope
 * for the editor pane.
 *
 * The answer is authoritative and the renderer never invents content: until
 * the host has answered — or when it refuses — there is no projection and the
 * workspace says the file is unavailable rather than showing an empty editor
 * that looks like an empty file. Loading is scoped to code-file tabs because
 * opening reads the checkout, and no other surface needs it.
 *
 * `refresh` re-runs that same authorized open, which is the only way to reach
 * fresh bytes and fresh metadata: the host releases a file's previous staging
 * when it re-opens it, so re-reading the old reference would serve exactly the
 * revision the editor is trying to leave behind. A refresh keeps the projection
 * it is replacing, because blanking it would unmount the editor pane and take
 * the user's unsaved draft and the revision that draft is based on with it —
 * the reopened file would then look like the draft's own origin and Save would
 * overwrite the external change. Only a change of file or checkout blanks the
 * projection, so the pane can never show one file's content under another's
 * name. Every run still cancels the answer of the run it replaced, and a run
 * that fails leaves the workspace saying the file is unavailable.
 */
export function useCodeEditorFile(options: {
  readonly client: CodeClient;
  readonly enabled: boolean;
  readonly relativePath?: CodeRelativePath;
  readonly threadId?: NonNullable<CodeController["activeView"]>["thread"]["id"];
  readonly checkoutId?: NonNullable<CodeController["activeView"]>["checkout"]["id"];
  readonly executionPolicy?: CodeThread["executionPolicy"];
}): {
  readonly file: CodeEditorFileProjection | undefined;
  readonly refresh: () => void;
} {
  const [file, setFile] = useState<CodeEditorFileProjection>();
  const [refreshGeneration, setRefreshGeneration] = useState(0);
  const openedScope = useRef<string | undefined>(undefined);
  const { client, enabled, relativePath, threadId, checkoutId, executionPolicy } = options;
  const refresh = useCallback(() => setRefreshGeneration((generation) => generation + 1), []);

  useEffect(() => {
    if (
      !enabled ||
      relativePath === undefined ||
      threadId === undefined ||
      checkoutId === undefined ||
      executionPolicy === undefined
    ) {
      openedScope.current = undefined;
      setFile(undefined);
      return;
    }
    let active = true;
    // A policy change re-reads the file but does not clear it. The open pane
    // holds the unsaved draft together with the revision that draft was based
    // on, and that pairing is what makes a change underneath it a conflict
    // rather than a silent overwrite; dropping the projection here would throw
    // the anchor away and let Save carry the new revision's digest.
    const scope = `${threadId}/${checkoutId}/${relativePath}`;
    if (openedScope.current !== scope) {
      openedScope.current = scope;
      setFile(undefined);
    }
    void client
      .openFile(threadId, checkoutId, relativePath)
      .then((result) => {
        if (active) {
          setFile(
            editorFileProjection(
              { checkoutId, executionPolicy, path: relativePath, threadId },
              result,
            ),
          );
        }
      })
      .catch(() => {
        if (active) setFile(undefined);
      });
    return () => void (active = false);
  }, [checkoutId, client, enabled, executionPolicy, refreshGeneration, relativePath, threadId]);

  // The posture is re-applied to whatever is already open, so a thread that
  // drops to Plan mode stops offering Save now rather than when the reopen
  // settles, while the pane it belongs to stays mounted.
  const posture = useMemo(
    () =>
      file === undefined || executionPolicy === undefined ? file : { ...file, executionPolicy },
    [executionPolicy, file],
  );

  return { file: posture, refresh };
}

export function editorFileProjection(
  scope: {
    readonly checkoutId: NonNullable<CodeController["activeView"]>["checkout"]["id"];
    readonly executionPolicy: CodeThread["executionPolicy"];
    readonly path: CodeRelativePath;
    readonly threadId: NonNullable<CodeController["activeView"]>["thread"]["id"];
  },
  result: CodeFileOpenResult,
): CodeEditorFileProjection {
  const fields = { ...scope, fileId: result.fileId, language: editorLanguageFor(scope.path) };
  switch (result.status) {
    case "editable":
      return { ...fields, state: "available", content: result.content, metadata: result.metadata };
    case "read-only":
      return { ...fields, state: "read-only", metadata: result.metadata, reason: result.reason };
    case "interrupted":
      return { ...fields, state: "unavailable", reason: "interrupted" };
    case "failed":
      return { ...fields, state: "unavailable", reason: result.failure.code };
  }
}

const EDITOR_LANGUAGES: Readonly<Record<string, string>> = {
  c: "c",
  cpp: "cpp",
  css: "css",
  go: "go",
  h: "c",
  html: "html",
  java: "java",
  js: "javascript",
  json: "json",
  jsx: "javascript",
  kt: "kotlin",
  md: "markdown",
  mjs: "javascript",
  py: "python",
  rb: "ruby",
  rs: "rust",
  sh: "shell",
  sql: "sql",
  swift: "swift",
  toml: "toml",
  ts: "typescript",
  tsx: "typescript",
  xml: "xml",
  yaml: "yaml",
  yml: "yaml",
};

export function editorLanguageFor(path: string): string {
  const separator = path.lastIndexOf(".");
  if (separator <= 0 || separator === path.length - 1) return "plaintext";
  return EDITOR_LANGUAGES[path.slice(separator + 1).toLowerCase()] ?? "plaintext";
}
