import type { CodeClient } from "@octant/client-runtime/code-client";
import {
  decodeCodeOperationCommand,
  decodeCodeRelativePath,
  type CodeDiffLayout,
  type CodeThreadId,
  type CodeThreadView,
  type CodeRelativePath,
  type CodeTurnReviewCapture,
  type CodeTurnReviewPreview,
} from "@octant/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import { OctantAlert } from "../ui/base/OctantAlert";
import { OctantButton } from "../ui/base/OctantButton";
import { ShellState } from "../shell/ShellState";
import { CodeDiffPane } from "./CodeDiffPane";
import { CodeLocalReview, readLocalReview, type CodeReviewLineSelection } from "./CodeLocalReview";
import type { CodeReviewFileRequest } from "./codeReviewNavigation";
import type { MonacoDiffRuntime } from "./MonacoEditorAdapter";
import { useCodeDiffIgnoreWhitespace } from "./codeDiffWhitespacePreference";

interface Props {
  readonly client: CodeClient;
  readonly view: CodeThreadView;
  readonly threadId: CodeThreadId;
  readonly request: CodeReviewFileRequest;
  readonly capture: CodeTurnReviewCapture;
  readonly defaultDiffLayout?: CodeDiffLayout;
  readonly createUuid?: () => string;
  readonly loadRuntime?: () => Promise<MonacoDiffRuntime>;
  readonly onOpenFile?: (path: CodeRelativePath) => void;
}

export function CodeTurnReviewTool(props: Props) {
  const client = useRef({ value: props.client, generation: 0 });
  if (client.current.value !== props.client)
    client.current = { value: props.client, generation: client.current.generation + 1 };
  return (
    <BoundTurnReview
      key={`${props.threadId}:${props.request.checkoutId}:${props.request.receiptOperationId}:${client.current.generation}`}
      {...props}
    />
  );
}

function BoundTurnReview(props: Props) {
  const owner = useRef(new AbortController());
  const generation = useRef(0);
  const [display, setDisplay] = useState<{ capture: CodeTurnReviewCapture; text: string }>();
  const [latest, setLatest] = useState<CodeTurnReviewPreview>({
    status: "ready",
    capture: props.capture,
    explanation: "Showing the requested captured version. Later checkout edits may be uncaptured.",
  });
  const [notice, setNotice] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [capturing, setCapturing] = useState(false);
  const capturePending = useRef(false);
  const [updates, setUpdates] = useState(0);
  const [line, setLine] = useState<CodeReviewLineSelection>();
  const [ignoreWhitespace, setIgnoreWhitespace] = useCodeDiffIgnoreWhitespace();
  const scope = { threadId: props.threadId, checkoutId: props.request.checkoutId };
  const operationId = props.request.receiptOperationId;

  useEffect(() => {
    const controller = new AbortController();
    owner.current.abort();
    owner.current = controller;
    return () => controller.abort();
  }, []);

  const load = useCallback(
    async (capture: CodeTurnReviewCapture) => {
      const signal = owner.current.signal;
      const request = ++generation.current;
      setLoading(true);
      setNotice(undefined);
      try {
        const text = await readLocalReview(async (readSignal) => {
          const bytes = await props.client.operationContent(
            props.threadId,
            operationId,
            capture.diff.contentId,
            readSignal,
          );
          if (bytes.byteLength !== capture.diff.byteLength)
            throw new Error("Captured bytes changed.");
          const digest = await crypto.subtle.digest("SHA-256", new Uint8Array(bytes));
          const hex = Array.from(new Uint8Array(digest), (byte) =>
            byte.toString(16).padStart(2, "0"),
          ).join("");
          if (hex !== capture.diff.digest) throw new Error("Captured comparison digest changed.");
          return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        }, signal);
        if (signal.aborted || request !== generation.current) return;
        setDisplay({ capture, text });
        setLine(undefined);
      } catch {
        if (!signal.aborted && request === generation.current)
          setNotice(
            "This captured version could not be read. The displayed version was kept; retry or reopen its original task. No current checkout diff was substituted.",
          );
      } finally {
        if (!signal.aborted && request === generation.current) setLoading(false);
      }
    },
    [props.client, props.threadId, operationId],
  );

  useEffect(() => {
    void load(props.capture);
  }, [load, props.capture]);

  const inspect = useCallback(
    async (refresh: boolean, signal: AbortSignal) => {
      const result = await readLocalReview(
        (readSignal) =>
          props.client.executeOperation(
            decodeCodeOperationCommand({
              kind: "observe-turn-review",
              operationId: props.createUuid?.() ?? globalThis.crypto.randomUUID(),
              threadId: props.threadId,
              checkoutId: props.request.checkoutId,
              turnOperationId: operationId,
              refresh,
            }),
            readSignal,
          ),
        signal,
      );
      if (signal.aborted) return;
      if (
        result.kind !== "turn-review-preview" ||
        result.threadId !== props.threadId ||
        result.checkoutId !== props.request.checkoutId ||
        result.turnOperationId !== operationId
      )
        throw new Error("Captured turn metadata is unavailable.");
      const preview = result.preview;
      if (
        preview.capture !== undefined &&
        (preview.capture.checkoutId !== props.request.checkoutId ||
          preview.capture.baseline !== props.capture.baseline)
      )
        throw new Error("The original captured baseline changed.");
      setLatest((previous) => {
        const before = previous.capture;
        const next = preview.capture;
        if (
          before !== undefined &&
          next !== undefined &&
          (next.version < before.version ||
            (next.version === before.version && next.cursor !== before.cursor))
        )
          return previous;
        const capture = next ?? before;
        return { ...preview, ...(capture === undefined ? {} : { capture }) };
      });
      return preview;
    },
    [
      props.client,
      props.threadId,
      props.request.checkoutId,
      props.createUuid,
      props.capture.baseline,
      operationId,
    ],
  );

  useEffect(() => {
    const controller = new AbortController();
    let reading = false;
    let timer: ReturnType<typeof setInterval> | undefined;
    const poll = async () => {
      if (reading || controller.signal.aborted) return;
      reading = true;
      try {
        const preview = await inspect(false, controller.signal);
        if (preview?.settled === true && timer !== undefined) clearInterval(timer);
      } catch {
        if (!controller.signal.aborted) {
          setNotice(
            "Live capture updates are unavailable. The displayed version was kept. Reconnect to retry.",
          );
          if (timer !== undefined) clearInterval(timer);
        }
      } finally {
        reading = false;
      }
    };
    void poll();
    // Metadata only. Passive reads never trigger Git capture.
    timer = setInterval(() => void poll(), 2_000);
    return () => {
      controller.abort();
      if (timer !== undefined) clearInterval(timer);
    };
  }, [inspect, updates]);

  async function captureNow() {
    if (capturePending.current) return;
    const signal = owner.current.signal;
    capturePending.current = true;
    setCapturing(true);
    setNotice(undefined);
    try {
      await inspect(true, signal);
    } catch {
      if (!signal.aborted)
        setNotice(
          "A fresh capture could not be confirmed. The displayed version was kept. Reconnect to read the latest recorded state before retrying.",
        );
    } finally {
      capturePending.current = false;
      if (!signal.aborted) setCapturing(false);
    }
  }

  const newer =
    latest.capture !== undefined &&
    latest.capture.cursor !== (display?.capture.cursor ?? props.capture.cursor)
      ? latest.capture
      : undefined;
  return (
    <>
      <section aria-label="Turn capture identity">
        <p>
          Turn {String(operationId).slice(-8)} · start tree {props.capture.baseline.slice(0, 8)}
        </p>
        <p role="status">{latest.explanation}</p>
        {display === undefined ? null : (
          <p>
            Viewing capture {display.capture.version} from{" "}
            <time dateTime={display.capture.capturedAt}>
              {new Date(display.capture.capturedAt).toLocaleString()}
            </time>
            . Other writers may be included; later edits may be uncaptured.
          </p>
        )}
        {newer === undefined ? null : (
          <OctantAlert tone="neutral">
            <p>
              {newer.final ? "The final" : "A newer"} capture {newer.version} is available. Existing
              notes keep their original version.
            </p>
            <OctantButton
              type="button"
              size="sm"
              variant="outline"
              disabled={loading}
              onClick={() => void load(newer)}
            >
              View {newer.final ? "final" : "newer"} capture
            </OctantButton>
          </OctantAlert>
        )}
        <OctantButton
          type="button"
          size="sm"
          variant="outline"
          disabled={
            capturing || latest.settled === true || props.view.thread.executionPolicy === "plan"
          }
          onClick={() => void captureNow()}
        >
          {capturing ? "Capturing…" : "Capture now"}
        </OctantButton>
        {props.view.thread.executionPolicy === "plan" ? (
          <p>
            Plan can read retained captures. Creating a fresh checkout comparison is unavailable at
            this access level.
          </p>
        ) : null}
        <OctantButton
          type="button"
          size="sm"
          variant="outline"
          onClick={() => {
            setNotice(undefined);
            setUpdates((value) => value + 1);
          }}
        >
          Reconnect updates
        </OctantButton>
        {loading ? (
          <p role="status">Reading the requested capture; the displayed version stays in place.</p>
        ) : null}
        {notice === undefined ? null : (
          <OctantAlert tone="warning">
            {notice}
            <OctantButton
              type="button"
              size="sm"
              variant="outline"
              disabled={loading}
              onClick={() => void load(newer ?? props.capture)}
            >
              Retry captured view
            </OctantButton>
          </OctantAlert>
        )}
      </section>
      {display === undefined ? (
        <ShellState
          state={loading ? "loading" : "warning"}
          title="Captured comparison unavailable"
        />
      ) : (
        <CodeDiffPane
          client={props.client}
          diff={{
            state: "turn",
            ...scope,
            operationId,
            capture: display.capture,
            text: display.text,
          }}
          requestedCodeReviewFile={props.request}
          {...(display.capture.diff.truncated === true ? {} : { onSelectReviewLine: setLine })}
          executionPolicy={props.view.thread.executionPolicy}
          ignoreWhitespace={{ value: ignoreWhitespace, onChange: setIgnoreWhitespace }}
          {...(props.defaultDiffLayout === undefined
            ? {}
            : { defaultLayout: props.defaultDiffLayout })}
          {...(props.loadRuntime === undefined ? {} : { loadRuntime: props.loadRuntime })}
          {...(props.onOpenFile === undefined
            ? {}
            : {
                onOpenFile: (path) => {
                  try {
                    props.onOpenFile?.(decodeCodeRelativePath(path));
                  } catch {
                    setNotice("This captured path cannot be opened in the current checkout.");
                  }
                },
              })}
        />
      )}
      <CodeLocalReview
        client={props.client}
        scope={scope}
        executionPolicy={props.view.thread.executionPolicy}
        {...(line === undefined ? {} : { line })}
        {...(props.createUuid === undefined ? {} : { createUuid: props.createUuid })}
        onRefreshComparison={() => setUpdates((value) => value + 1)}
      />
    </>
  );
}
