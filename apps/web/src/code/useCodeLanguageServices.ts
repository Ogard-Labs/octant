import type { CodeClient } from "@octant/client-runtime/code-client";
import type {
  CodeCheckoutId,
  CodeFileId,
  CodeRelativePath,
  CodeThreadId,
} from "@octant/contracts/code";
import type {
  CodeLanguageApprovalScope,
  CodeLanguageDefinitionTarget,
  CodeLanguageDiagnostic,
  CodeLanguageDocumentResult,
  CodeLanguagePosition,
  CodeLanguageReadResult,
  CodeLanguageRefusalReason,
} from "@octant/contracts/code-language";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  languageStatusText,
  refusedState,
  type CodeLanguageEditorState,
} from "./codeLanguageEditor";

/**
 * Keeps one editor's file open with the host's language server and reads its
 * diagnostics. Canonical: docs/design/language-services.md (editor wiring).
 *
 * The host decides everything: whether a server reads this file, whether this
 * caller may ask, and whether a server starts. The editor sends what the
 * person has typed (debounced) and shows the answer. A refusal or a wait is a
 * state to show, never an error, and the editor keeps working without it.
 */

export type CodeLanguageClient = Pick<
  CodeClient,
  "syncLanguageDocument" | "readLanguage" | "approveLanguageServer"
>;

/** What came of the person's approval of a server that runs the repository's tooling. */
export type CodeLanguageApprovalOutcome =
  /** Approved, and the file is opened with the server again. */
  | "approved"
  /** The host refused it; the state says why. */
  | "refused"
  /** The host did not record it, so it is not in force. */
  | "not-recorded"
  /** The request did not reach the host. */
  | "failed";

export type CodeLanguageDefinitionOutcome =
  | { readonly status: "targets"; readonly targets: ReadonlyArray<CodeLanguageDefinitionTarget> }
  /** No answer to act on; the state says why when there is something to say. */
  | { readonly status: "none" }
  /** The host holds no document for this file, so no server can answer. */
  | { readonly status: "unserved" };

export type CodeLanguageReferencesOutcome =
  | Extract<CodeLanguageReadResult, { readonly status: "references" | "unsupported" }>
  | { readonly status: "unavailable"; readonly message: string; readonly reloadLanguage?: true };

export type CodeLanguageEditOutcome =
  | Extract<
      CodeLanguageReadResult,
      { status: "edit-previews" | "edit-unavailable" | "unsupported" }
    >
  | { readonly status: "unavailable"; readonly message: string; readonly reloadLanguage?: true };
type EditQuery =
  | { readonly kind: "rename"; readonly newName: string }
  | { readonly kind: "quick-fixes" };

export interface CodeLanguageServices {
  readonly prepareEdits: (
    position: CodeLanguagePosition,
    query: EditQuery,
  ) => Promise<CodeLanguageEditOutcome | undefined>;
  readonly state: CodeLanguageEditorState;
  /** The server's diagnostics, or undefined while no server serves the file. */
  readonly diagnostics: ReadonlyArray<CodeLanguageDiagnostic> | undefined;
  readonly definition: (position: CodeLanguagePosition) => Promise<CodeLanguageDefinitionOutcome>;
  readonly references: (
    position: CodeLanguagePosition,
  ) => Promise<CodeLanguageReferencesOutcome | undefined>;
  readonly cancelReferences: () => void;
  /** Opens the file again: how a person retries a server that stopped. */
  readonly retry: () => void;
  /** Reads diagnostics again, for when other files may have changed them. */
  readonly refresh: () => void;
  /**
   * Approves the server that reads this file to run the repository's
   * tooling, for its checkout or its Project. Absent for a client without the
   * approval route. The host takes it only from a local window.
   */
  readonly approve:
    | ((scope: CodeLanguageApprovalScope) => Promise<CodeLanguageApprovalOutcome>)
    | undefined;
}

export interface CodeLanguageServicesOptions {
  readonly client: CodeLanguageClient;
  readonly enabled: boolean;
  readonly threadId: CodeThreadId;
  readonly checkoutId: CodeCheckoutId;
  readonly path: CodeRelativePath;
  /** The editor's current text, saved or not. */
  readonly text: string;
  readonly timing?: { readonly debounceMs?: number; readonly pollMs?: number };
}

/** Typing settles for this long before the text is sent. */
const DEBOUNCE_MS = 300;
/** How often a server that is still starting is asked again. */
const POLL_MS = 1_000;
/** A server still starting after this many polls is reported as not answering. */
const MAX_STARTING_POLLS = 30;
/** A first answer slower than this shows the server as starting. */
const STARTING_NOTICE_MS = 400;

export function useCodeLanguageServices(
  options: CodeLanguageServicesOptions,
): CodeLanguageServices {
  const { client, enabled, threadId, checkoutId, path, text } = options;
  const debounceMs = options.timing?.debounceMs ?? DEBOUNCE_MS;
  const pollMs = options.timing?.pollMs ?? POLL_MS;
  const supported = client.syncLanguageDocument !== undefined && client.readLanguage !== undefined;
  const active = enabled && supported;

  const [state, setState] = useState<CodeLanguageEditorState>({ kind: "inactive" });
  const [diagnostics, setDiagnostics] = useState<ReadonlyArray<CodeLanguageDiagnostic>>();
  const [openGeneration, setOpenGeneration] = useState(0);

  const textRef = useRef(text);
  useLayoutEffect(() => {
    textRef.current = text;
  }, [text]);
  /** Sends the editor's text; set while a document session is live. */
  const syncRef = useRef<((text: string) => void) | undefined>(undefined);
  const readRef = useRef<(() => void) | undefined>(undefined);
  /** The text the host holds, so an unchanged editor sends nothing. */
  const syncedText = useRef<string | undefined>(undefined);
  const fileId = useRef<CodeFileId | undefined>(undefined);
  const documentRevision = useRef<string | undefined>(undefined);
  const pendingReferenceSync = useRef<
    | {
        readonly generation: number;
        readonly fileId: CodeFileId;
        readonly priorRevision: string;
        readonly text: string;
      }
    | undefined
  >(undefined);
  /** Bumped when the document is reopened or released; stale answers are dropped. */
  const session = useRef(0);
  const readSequence = useRef(0);
  const referenceSequence = useRef(0);
  const referenceAbort = useRef<AbortController | undefined>(undefined);
  const referenceIdentity = useMemo(
    () => ({ active, client, threadId, checkoutId, path }),
    [active, client, threadId, checkoutId, path],
  );
  const currentReferenceIdentity = useRef(referenceIdentity);
  currentReferenceIdentity.current = referenceIdentity;
  const startingPolls = useRef(0);
  const reopened = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const clearTimer = useCallback(() => {
    if (timer.current !== undefined) clearTimeout(timer.current);
    timer.current = undefined;
  }, []);

  const show = useCallback((next: CodeLanguageEditorState) => {
    setState(next);
    if (next.kind !== "ready") setDiagnostics(undefined);
  }, []);

  useEffect(() => {
    clearTimer();
    const current = ++session.current;
    referenceSequence.current += 1;
    referenceAbort.current?.abort();
    fileId.current = undefined;
    documentRevision.current = undefined;
    pendingReferenceSync.current = undefined;
    syncedText.current = undefined;
    startingPolls.current = 0;
    reopened.current = false;
    if (!active) {
      show({ kind: "inactive" });
      return;
    }
    const sync = client.syncLanguageDocument?.bind(client);
    const read = client.readLanguage?.bind(client);
    if (sync === undefined || read === undefined) return;
    const live = () => session.current === current;
    // Most files are answered at once, often with no server to read them;
    // only a wait the person would notice is shown as starting.
    show({ kind: "inactive" });
    let answered = false;
    const startingNotice = setTimeout(() => {
      if (live() && !answered) show({ kind: "starting" });
    }, STARTING_NOTICE_MS);

    /**
     * Text typed while a sync was in flight, sent once it settles. Its own
     * timer: a starting server's poll shares `later`, and replacing this send
     * left the host reading the older text (observed with a slow first open).
     */
    let resend: ReturnType<typeof setTimeout> | undefined;

    const later = (run: () => void, delay: number) => {
      clearTimer();
      timer.current = setTimeout(() => {
        timer.current = undefined;
        if (live()) run();
      }, delay);
    };

    /**
     * A refusal stands until the person retries, so the editor stops sending
     * text the host has already said it will not take.
     */
    const refuse = (reason: CodeLanguageRefusalReason) => {
      fileId.current = undefined;
      documentRevision.current = undefined;
      syncedText.current = undefined;
      show(refusedState(reason));
    };

    /** Asks again while the server starts, until it has had long enough. */
    const waitForStart = (ask: () => void) => {
      startingPolls.current += 1;
      if (startingPolls.current > MAX_STARTING_POLLS) {
        show({ kind: "timed-out" });
        return;
      }
      show({ kind: "starting" });
      later(ask, pollMs);
    };

    const readDiagnostics = () => {
      const opened = fileId.current;
      if (opened === undefined) return;
      const sequence = ++readSequence.current;
      void read({ kind: "diagnostics", threadId, checkoutId, fileId: opened })
        .then((result) => {
          if (live() && sequence === readSequence.current) applyRead(result);
        })
        .catch(() => {
          if (live() && sequence === readSequence.current) show({ kind: "timed-out" });
        });
    };

    const applyRead = (result: CodeLanguageReadResult) => {
      answered = true;
      switch (result.status) {
        case "diagnostics":
          startingPolls.current = 0;
          reopened.current = false;
          setDiagnostics(result.diagnostics);
          setState({
            kind: "ready",
            problems: result.diagnostics.filter((diagnostic) => diagnostic.path === path).length,
            truncated: result.truncated,
          });
          return;
        case "definition":
          return;
        case "unavailable":
          if (result.reason === "starting") {
            waitForStart(readDiagnostics);
            return;
          }
          show({ kind: result.reason });
          return;
        case "refused":
          // A restarted, idle-closed, or retired server no longer holds the
          // document; opening it again once is the ordinary recovery.
          if (result.reason === "file-outside-thread" && !reopened.current) {
            reopened.current = true;
            open();
            return;
          }
          refuse(result.reason);
      }
    };

    const applyDocument = (result: CodeLanguageDocumentResult, sentText: string) => {
      // A synced document is not an answer yet: its diagnostics are.
      if (result.status !== "synced") answered = true;
      switch (result.status) {
        case "synced":
          fileId.current = result.fileId;
          documentRevision.current = result.documentRevision;
          syncedText.current = sentText;
          readDiagnostics();
          // Text typed while this was in flight has not been sent yet.
          if (textRef.current !== sentText) {
            clearTimeout(resend);
            resend = setTimeout(() => {
              if (live()) syncRef.current?.(textRef.current);
            }, debounceMs);
          }
          return;
        case "too-large":
          syncedText.current = sentText;
          show({ kind: "too-large" });
          return;
        case "unavailable":
          if (result.reason === "starting") {
            waitForStart(open);
            return;
          }
          show({ kind: result.reason });
          return;
        case "refused":
          if (result.reason === "file-outside-thread" && !reopened.current) {
            reopened.current = true;
            open();
            return;
          }
          refuse(result.reason);
      }
    };

    function open() {
      if (sync === undefined) return;
      fileId.current = undefined;
      documentRevision.current = undefined;
      // Opening is the host's retry and resets a crashed server's budget, so
      // an edit reopens only what the host answered `too-large`; any other
      // answer to this open stands until the person retries.
      syncedText.current = undefined;
      const sentText = textRef.current;
      void sync({ kind: "open", threadId, checkoutId, path, text: sentText })
        .then((result) => {
          if (live()) applyDocument(result, sentText);
        })
        .catch(() => {
          if (live()) show({ kind: "timed-out" });
        });
    }

    syncRef.current = (sentText: string) => {
      const opened = fileId.current;
      if (opened === undefined || sync === undefined) {
        // Only a file that was too large is reopened on edit: every other
        // state without a document is the host's answer until a retry.
        if (syncedText.current !== undefined) open();
        return;
      }
      void sync({ kind: "change", threadId, checkoutId, fileId: opened, text: sentText })
        .then((result) => {
          if (live()) applyDocument(result, sentText);
        })
        .catch(() => {
          if (live()) show({ kind: "timed-out" });
        });
    };
    readRef.current = readDiagnostics;
    open();

    return () => {
      session.current += 1;
      referenceSequence.current += 1;
      referenceAbort.current?.abort();
      clearTimeout(startingNotice);
      clearTimeout(resend);
      clearTimer();
      const held = fileId.current;
      fileId.current = undefined;
      documentRevision.current = undefined;
      syncRef.current = undefined;
      readRef.current = undefined;
      // The host closes the document when the last holder lets it go; one
      // that never hears this closes it after its idle period.
      if (held !== undefined) {
        void sync({ kind: "close", threadId, checkoutId, fileId: held }).catch(() => undefined);
      }
    };
    // The text is read through its ref: typing never reopens the document.
  }, [
    active,
    checkoutId,
    clearTimer,
    client,
    debounceMs,
    openGeneration,
    path,
    pollMs,
    show,
    threadId,
  ]);

  useEffect(() => {
    if (!active || syncedText.current === undefined || syncedText.current === text) return;
    const handle = setTimeout(() => syncRef.current?.(text), debounceMs);
    return () => clearTimeout(handle);
  }, [active, debounceMs, text]);

  const definition = useCallback(
    async (position: CodeLanguagePosition): Promise<CodeLanguageDefinitionOutcome> => {
      const opened = fileId.current;
      const read = client.readLanguage?.bind(client);
      if (opened === undefined || read === undefined) return { status: "unserved" };
      const current = session.current;
      let result: CodeLanguageReadResult;
      try {
        result = await read({ kind: "definition", threadId, checkoutId, fileId: opened, position });
      } catch {
        return { status: "none" };
      }
      if (session.current !== current) return { status: "none" };
      if (result.status === "definition") return { status: "targets", targets: result.targets };
      if (result.status === "unavailable" && result.reason !== "starting") {
        show({ kind: result.reason });
      } else if (result.status === "refused") {
        // A document the host let go is reopened by the diagnostics read,
        // which knows how; every other refusal is shown as it stands.
        if (result.reason === "file-outside-thread") readRef.current?.();
        else show(refusedState(result.reason));
      }
      return { status: "none" };
    },
    [checkoutId, client, show, threadId],
  );

  const cancelReferences = useCallback(() => {
    referenceSequence.current += 1;
    referenceAbort.current?.abort();
  }, []);

  useEffect(() => {
    referenceSequence.current += 1;
    referenceAbort.current?.abort();
  }, [text]);

  const queryCompanion = useCallback(
    async (
      position: CodeLanguagePosition,
      query?: EditQuery,
    ): Promise<CodeLanguageReferencesOutcome | CodeLanguageEditOutcome | undefined> => {
      const unavailable = (message: string): CodeLanguageReferencesOutcome => ({
        status: "unavailable",
        message,
      });
      const opened = fileId.current;
      const read = client.readLanguage?.bind(client);
      const sync = client.syncLanguageDocument?.bind(client);
      if (!active || opened === undefined || read === undefined || sync === undefined)
        return unavailable(
          "Language services are not available for this file. Retry or open it externally.",
        );
      const generation = session.current;
      const reloadRequired = (): CodeLanguageReferencesOutcome => ({
        status: "unavailable",
        reloadLanguage: true,
        message:
          "The previous text sync could not be confirmed. Reload the language document explicitly, then find references again.",
      });
      const pending = pendingReferenceSync.current;
      if (pending !== undefined) {
        if (
          pending.generation === generation &&
          pending.fileId === opened &&
          pending.priorRevision === documentRevision.current
        )
          return reloadRequired();
        pendingReferenceSync.current = undefined;
      }
      const sequence = ++referenceSequence.current;
      referenceAbort.current?.abort();
      const controller = new AbortController();
      referenceAbort.current = controller;
      const currentText = textRef.current;
      const deadline = performance.now() + 15000;
      const live = () =>
        currentReferenceIdentity.current === referenceIdentity &&
        session.current === generation &&
        referenceSequence.current === sequence &&
        fileId.current === opened &&
        textRef.current === currentText;
      const current = () => live() && !controller.signal.aborted && performance.now() < deadline;
      const timedOut = unavailable(
        "The language server did not answer in time. Retry or open this file externally.",
      );
      const stopped = () =>
        live() && (controller.signal.aborted || performance.now() >= deadline)
          ? timedOut
          : undefined;
      const matches = (answer: {
        readonly threadId: CodeThreadId;
        readonly checkoutId: CodeCheckoutId;
        readonly fileId: CodeFileId;
      }) =>
        answer.threadId === threadId &&
        answer.checkoutId === checkoutId &&
        answer.fileId === opened;
      const unanswered = (
        answer: CodeLanguageReadResult | CodeLanguageDocumentResult,
      ): CodeLanguageReferencesOutcome =>
        answer.status === "refused"
          ? unavailable(
              languageStatusText(refusedState(answer.reason)) ??
                "No language server reads this file. Open it externally.",
            )
          : answer.status === "stale"
            ? unavailable(
                "The file changed while finding references. Check the current text and try again.",
              )
            : unavailable(
                "References are not available from this host. Retry or open this file externally.",
              );
      const operation = async (): Promise<
        CodeLanguageReferencesOutcome | CodeLanguageEditOutcome | undefined
      > => {
        const support = await read(
          { kind: "capabilities", threadId, checkoutId, fileId: opened },
          controller.signal,
        );
        if (!current()) return stopped();
        if (support.status !== "capabilities" || !matches(support)) return unanswered(support);
        const capability = query?.kind ?? "references";
        const available =
          query?.kind === "rename"
            ? (support.rename ?? "unknown")
            : query?.kind === "quick-fixes"
              ? (support.quickFixes ?? "unknown")
              : support.references;
        if (available !== "supported")
          return { status: "unsupported", capability, support: available };
        // This is an acknowledgement of the person's current draft, not a save.
        const expectedRevision = documentRevision.current;
        if (expectedRevision === undefined)
          return unavailable(
            "The host could not confirm the current file text. Reconnect or open this file externally.",
          );
        const attempt = {
          generation,
          fileId: opened,
          priorRevision: expectedRevision,
          text: currentText,
        };
        pendingReferenceSync.current = attempt;
        let acknowledged: CodeLanguageDocumentResult;
        try {
          acknowledged = await sync(
            {
              kind: "change",
              threadId,
              checkoutId,
              fileId: opened,
              text: currentText,
              expectedRevision,
            },
            controller.signal,
          );
        } catch {
          return current() ? reloadRequired() : stopped();
        }
        // Cancelling the query does not undo an already-applied memory sync.
        // Keep only an acknowledgement of this exact original document/text,
        // never a stale reply over a newer session or acknowledged revision.
        if (
          acknowledged.status === "synced" &&
          matches(acknowledged) &&
          acknowledged.documentVersion !== undefined &&
          acknowledged.documentRevision !== undefined &&
          currentReferenceIdentity.current === referenceIdentity &&
          session.current === generation &&
          fileId.current === opened &&
          textRef.current === currentText &&
          documentRevision.current === expectedRevision
        ) {
          documentRevision.current = acknowledged.documentRevision;
          syncedText.current = currentText;
          if (pendingReferenceSync.current === attempt) pendingReferenceSync.current = undefined;
        } else if (acknowledged.status !== "synced" && pendingReferenceSync.current === attempt)
          pendingReferenceSync.current = undefined;
        if (!current()) return stopped();
        if (acknowledged.status !== "synced" || !matches(acknowledged))
          return acknowledged.status === "stale" ? reloadRequired() : unanswered(acknowledged);
        if (
          acknowledged.documentVersion === undefined ||
          acknowledged.documentRevision === undefined
        )
          return unavailable(
            "The host could not confirm the current file text. Reconnect or open this file externally.",
          );
        if (documentRevision.current !== acknowledged.documentRevision) return reloadRequired();
        const answer = await read(
          {
            ...(query ?? { kind: "references", includeDeclaration: true }),
            threadId,
            checkoutId,
            fileId: opened,
            position,
            expectedVersion: acknowledged.documentVersion,
            expectedRevision: acknowledged.documentRevision,
          },
          controller.signal,
        );
        if (!current()) return stopped();
        if (answer.status === "unsupported") return answer;
        if (answer.status === "edit-unavailable") return answer;
        if (answer.status !== "references" && answer.status !== "edit-previews")
          return unanswered(answer);
        if (
          !matches(answer) ||
          answer.documentVersion !== acknowledged.documentVersion ||
          answer.documentRevision !== acknowledged.documentRevision
        )
          return unavailable(
            "The host answered for another file revision. Check the current text and try again.",
          );
        return answer;
      };
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const answer = await Promise.race([
          operation().catch(() =>
            current()
              ? unavailable(
                  "References could not be read from the host. Retry or open this file externally.",
                )
              : stopped(),
          ),
          new Promise<CodeLanguageReferencesOutcome | CodeLanguageEditOutcome | undefined>(
            (resolve) => {
              controller.signal.addEventListener(
                "abort",
                () => resolve(live() ? timedOut : undefined),
                { once: true },
              );
              timer = setTimeout(() => controller.abort(), 15000);
            },
          ),
        ]);
        return current() ? answer : stopped();
      } finally {
        clearTimeout(timer);
        controller.abort();
        if (referenceAbort.current === controller) referenceAbort.current = undefined;
      }
    },
    [active, checkoutId, client, referenceIdentity, threadId],
  );

  const references = useCallback(
    async (position: CodeLanguagePosition): Promise<CodeLanguageReferencesOutcome | undefined> => {
      const answer = await queryCompanion(position);
      return answer?.status === "edit-previews" || answer?.status === "edit-unavailable"
        ? undefined
        : answer;
    },
    [queryCompanion],
  );
  const prepareEdits = useCallback(
    async (
      position: CodeLanguagePosition,
      query: EditQuery,
    ): Promise<CodeLanguageEditOutcome | undefined> => {
      const answer = await queryCompanion(position, query);
      return answer?.status === "references" ? undefined : answer;
    },
    [queryCompanion],
  );

  const retry = useCallback(() => setOpenGeneration((generation) => generation + 1), []);
  const refresh = useCallback(() => readRef.current?.(), []);

  const approve = useMemo(() => {
    const request = client.approveLanguageServer?.bind(client);
    if (request === undefined) return undefined;
    return async (scope: CodeLanguageApprovalScope): Promise<CodeLanguageApprovalOutcome> => {
      let result: Awaited<ReturnType<typeof request>>;
      try {
        result = await request({ threadId, checkoutId, path, scope });
      } catch {
        return "failed";
      }
      switch (result.status) {
        case "approved":
        // A server that needs no approval after all is opened the same way.
        case "not-required":
          retry();
          return "approved";
        case "refused":
          show(refusedState(result.reason));
          return "refused";
        case "not-recorded":
          return "not-recorded";
      }
    };
  }, [checkoutId, client, path, retry, show, threadId]);

  return {
    state,
    diagnostics,
    definition,
    references,
    prepareEdits,
    cancelReferences,
    retry,
    refresh,
    approve,
  };
}
