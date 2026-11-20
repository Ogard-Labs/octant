import { createHash } from "node:crypto";
import { isAbsolute, relative, resolve, sep } from "node:path";
import {
  CODE_LANGUAGE_TOOL_NAME,
  decodeCodeProjectFilePath,
  type CodeRelativePath,
  type CodeThread,
  type WindowId,
} from "@octant/contracts";
import {
  EDIT_DIAGNOSTICS_TIMEOUT_MS,
  classifyPathContainment,
  formatEditDiagnostics,
} from "@octant/domain";
import type {
  ExternalContentIngestionResult,
  RecordExternalContentIngestionInput,
} from "../context/externalContentIngestionStore";
import type { NativeHarnessEditDiagnosticsPort } from "../harness/nativeHarnessTools";
import type { CodeLanguageAgentReadResult, CodeLanguageService } from "./codeLanguageService";

/**
 * Post-edit language-server diagnostics for Octant Harness `write`, `edit`, and
 * `editFiles`. Canonical: docs/design/language-services.md § Agent read rules.
 *
 * Reads the edited files through `CodeLanguageService.readForAgent` under one
 * shared 3.5 s budget so multi-file edits never multiply wait time. Paths
 * returned by `NativeHarnessFileSystem` are resolved against the harness
 * filesystem root (`harnessRoot`, which may be a selected subdirectory or an
 * approved extra working folder) and translated into main-checkout-relative
 * paths or absolute extra-folder paths before querying `CodeLanguageService`.
 *
 * When attaching diagnostics to a large edit response (such as a 20-file
 * `editFiles`), entries are bounded against `fits` before any outside-content
 * ingestion is recorded so the edit result stays within the 64 KiB tool-result
 * limit and `repo-tooling` provenance covers only retained entries.
 */

export interface CodeEditDiagnosticsOptions {
  readonly windowId: WindowId;
  readonly thread: Pick<CodeThread, "id" | "checkoutId">;
  /**
   * The harness filesystem root (`active.providerRoot`) relative edit paths
   * resolve against. Absent in tests where edited paths are already
   * checkout-relative.
   */
  readonly harnessRoot?: string;
  /**
   * The thread's main checkout root (`active.checkoutRoot`). Used with
   * `harnessRoot` to distinguish main-checkout subdirectories from approved
   * extra working folders.
   */
  readonly mainCheckoutRoot?: string;
  readonly language: Pick<CodeLanguageService, "readForAgent">;
  readonly recordExternalContentIngestion: (
    input: RecordExternalContentIngestionInput,
  ) => ExternalContentIngestionResult;
  readonly uuid: () => string;
  readonly timeoutMs?: number;
  readonly now?: () => number;
}

interface FormattedFileDiagnostics {
  readonly text: string;
  readonly repositoryTooling?: true;
}

export function createCodeEditDiagnostics(
  options: CodeEditDiagnosticsOptions,
): NativeHarnessEditDiagnosticsPort {
  const timeoutMs = options.timeoutMs ?? EDIT_DIAGNOSTICS_TIMEOUT_MS;
  const now = options.now ?? (() => performance.now());

  return async ({ paths, signal, fits }) => {
    if (signal?.aborted === true) return undefined;
    const uniquePaths = [...new Set(paths)];
    if (uniquePaths.length === 0) return undefined;
    const deadline = now() + Math.max(0, timeoutMs);

    const perFile = await Promise.all(
      uniquePaths.map((filePath) =>
        checkFile({
          options,
          filePath,
          deadline,
          now,
          ...(signal === undefined ? {} : { signal }),
        }),
      ),
    );
    const present = perFile.filter(
      (entry): entry is FormattedFileDiagnostics => entry !== undefined,
    );
    if (present.length === 0) return undefined;

    const fitted = selectFittedEntries(present, fits);
    let kept = fitted.kept;
    const omittedForSize = fitted.omittedForSize;

    const repoToolingEntries = kept.filter((entry) => entry.repositoryTooling === true);
    let repositoryTooling = false;
    if (repoToolingEntries.length > 0) {
      const repoText = repoToolingEntries.map((entry) => entry.text).join("\n");
      const digest = createHash("sha256").update(repoText).digest("hex");
      const recorded = recordRepositoryToolingIngestion(options, digest);
      if (recorded) {
        repositoryTooling = true;
      } else {
        // Never leak unmarked repository-tooling output; keep any static
        // answers and let the already-written edit succeed cleanly.
        kept = kept.filter((entry) => entry.repositoryTooling !== true);
      }
    }

    const text = formatDiagnosticsWithNotice(kept, omittedForSize);
    if (text.length === 0) return undefined;
    if (fits !== undefined && !fits(text)) return undefined;
    return repositoryTooling ? { text, repositoryTooling: true } : { text };
  };
}

/**
 * Translates a path returned by `NativeHarnessFileSystem` (relative to
 * `harnessRoot`, or absolute for an extra root) into the path
 * `CodeLanguageService.readForAgent` expects: relative to `mainCheckoutRoot`
 * when inside the main checkout, or an absolute POSIX path when inside an
 * approved extra folder.
 */
function resolveLanguagePath(
  filePath: string,
  harnessRoot: string | undefined,
  mainCheckoutRoot: string | undefined,
): CodeRelativePath | undefined {
  try {
    if (harnessRoot === undefined) {
      return decodeCodeProjectFilePath(filePath);
    }
    const absolute = isAbsolute(filePath) ? resolve(filePath) : resolve(harnessRoot, filePath);
    const checkoutRoot = mainCheckoutRoot ?? harnessRoot;
    if (classifyPathContainment(checkoutRoot, absolute) === "contained") {
      const rel = relative(checkoutRoot, absolute).split(sep).join("/");
      if (rel === "" || rel === ".") return undefined;
      return decodeCodeProjectFilePath(rel);
    }
    return decodeCodeProjectFilePath(absolute.split(sep).join("/"));
  } catch {
    return undefined;
  }
}

function selectFittedEntries(
  entries: ReadonlyArray<FormattedFileDiagnostics>,
  fits: ((diagnostics: string) => boolean) | undefined,
): {
  readonly kept: ReadonlyArray<FormattedFileDiagnostics>;
  readonly omittedForSize: number;
} {
  if (fits === undefined) return { kept: entries, omittedForSize: 0 };
  const full = entries.map((entry) => entry.text).join("\n");
  if (fits(full)) return { kept: entries, omittedForSize: 0 };

  const kept: FormattedFileDiagnostics[] = [];
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (entry === undefined) continue;
    const next = [...kept, entry];
    const omitted = entries.length - next.length;
    if (!fits(formatDiagnosticsWithNotice(next, omitted))) break;
    kept.push(entry);
  }
  return { kept, omittedForSize: entries.length - kept.length };
}

function formatDiagnosticsWithNotice(
  kept: ReadonlyArray<FormattedFileDiagnostics>,
  omittedForSize: number,
): string {
  const parts = kept.map((entry) => entry.text);
  if (omittedForSize > 0) {
    const noun = omittedForSize === 1 ? "file" : "files";
    const prefix = kept.length > 0 ? "more " : "";
    parts.push(
      `Diagnostics omitted for ${omittedForSize} ${prefix}${noun} to keep the edit result within its size limit.`,
    );
  }
  return parts.join("\n");
}

async function checkFile(input: {
  readonly options: CodeEditDiagnosticsOptions;
  readonly filePath: string;
  readonly deadline: number;
  readonly now: () => number;
  readonly signal?: AbortSignal;
}): Promise<FormattedFileDiagnostics | undefined> {
  if (input.signal?.aborted === true) return undefined;
  const remainingMs = input.deadline - input.now();
  if (remainingMs <= 0) return undefined;
  const decodedPath = resolveLanguagePath(
    input.filePath,
    input.options.harnessRoot,
    input.options.mainCheckoutRoot,
  );
  if (decodedPath === undefined) return undefined;
  const read = input.options.language
    .readForAgent(
      input.options.windowId,
      {
        kind: "diagnostics",
        threadId: input.options.thread.id,
        checkoutId: input.options.thread.checkoutId,
        path: decodedPath,
      },
      {
        deadlineMs: remainingMs,
        waitForPushed: true,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      },
    )
    .catch((): undefined => undefined);

  const answer = await boundRead(read, remainingMs, input.signal);
  if (answer === undefined || answer.status !== "diagnostics") return undefined;
  const text = formatEditDiagnostics(input.filePath, answer.diagnostics);
  return answer.repositoryTooling === true ? { text, repositoryTooling: true } : { text };
}

function boundRead(
  promise: Promise<CodeLanguageAgentReadResult | undefined>,
  timeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<CodeLanguageAgentReadResult | undefined> {
  if (signal?.aborted === true || timeoutMs <= 0) return Promise.resolve(undefined);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: CodeLanguageAgentReadResult | undefined) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve(value);
    };
    const onAbort = () => finish(undefined);
    const timer = setTimeout(() => finish(undefined), timeoutMs);
    timer.unref?.();
    signal?.addEventListener("abort", onAbort, { once: true });
    void promise.then(
      (value) => finish(value),
      () => finish(undefined),
    );
  });
}

function recordRepositoryToolingIngestion(
  options: CodeEditDiagnosticsOptions,
  digest: string,
): boolean {
  try {
    const ingested = options.recordExternalContentIngestion({
      threadId: options.thread.id,
      provenance: { origin: "tool-result", sourceLabel: CODE_LANGUAGE_TOOL_NAME },
      contentReference: `app-managed-${CODE_LANGUAGE_TOOL_NAME}-${digest}`,
      correlationId: options.uuid(),
      authorized: true,
    });
    return ingested.kind !== "refused";
  } catch {
    return false;
  }
}
