import { createHash } from "node:crypto";
import {
  CODE_LANGUAGE_TOOL_NAME,
  decodeCodeProjectFilePath,
  type CodeRelativePath,
  type CodeThread,
  type WindowId,
} from "@octant/contracts";
import { EDIT_DIAGNOSTICS_TIMEOUT_MS, formatEditDiagnostics } from "@octant/domain";
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
 * shared 3.5 s budget so multi-file edits never multiply wait time. A server
 * that is running, or one the thread's access posture may start (any `static`
 * server, or a `repo-tooling` server at Full access), answers with errors only
 * (up to five `path:line:col message` lines cut to 200 characters plus
 * `and N more`, or `No errors in <file>`). Anything unavailable, refused (such
 * as an unapproved `repo-tooling` server below Full access), or past the
 * deadline adds nothing and never blocks or asks for approval. Answers from a
 * `repo-tooling` server are journaled as outside content before they are
 * attached, and withheld if the mark cannot be recorded.
 */

export interface CodeEditDiagnosticsOptions {
  readonly windowId: WindowId;
  readonly thread: Pick<CodeThread, "id" | "checkoutId">;
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

  return async ({ paths, signal }) => {
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

    const repoToolingEntries = present.filter((entry) => entry.repositoryTooling === true);
    let kept = present;
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
        kept = present.filter((entry) => entry.repositoryTooling !== true);
      }
    }
    if (kept.length === 0) return undefined;
    const text = kept.map((entry) => entry.text).join("\n");
    return repositoryTooling ? { text, repositoryTooling: true } : { text };
  };
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
  let decodedPath: CodeRelativePath;
  try {
    decodedPath = decodeCodeProjectFilePath(input.filePath);
  } catch {
    return undefined;
  }
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
