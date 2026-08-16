import type { CodeClient } from "@octant/client-runtime/code-client";
import type { CodeCheckoutId, CodeThreadId } from "@octant/contracts/code";
import type { CodeOperationResult } from "@octant/contracts/code-operations";
import { useEffect, useRef, useState } from "react";
import { MonacoEditorAdapter, type MonacoAdapterRuntime } from "./MonacoEditorAdapter";

type GitObservation = Extract<CodeOperationResult, { readonly kind: "git-observed" }>;

export type CodeDiffProjection =
  | {
      readonly state: "available";
      readonly checkoutId: CodeCheckoutId;
      readonly threadId: CodeThreadId;
      readonly observation: GitObservation;
    }
  | { readonly state: "loading" }
  | { readonly state: "stale" | "unavailable"; readonly message: string };

export interface CodeDiffPaneProps {
  readonly client: Pick<CodeClient, "operationContent">;
  readonly diff: CodeDiffProjection;
  readonly loadRuntime?: () => Promise<MonacoAdapterRuntime>;
}

type ContentState =
  | { readonly kind: "loading" }
  | { readonly kind: "ready"; readonly text: string }
  | { readonly kind: "unavailable"; readonly message: string };

export function CodeDiffPane(props: CodeDiffPaneProps) {
  if (props.diff.state === "loading") return <p role="status">Loading Git diff…</p>;
  if (props.diff.state !== "available") {
    return <p role="alert">{props.diff.message}</p>;
  }
  return <AvailableDiff {...props} diff={props.diff} />;
}

function AvailableDiff(
  props: CodeDiffPaneProps & {
    readonly diff: Extract<CodeDiffProjection, { readonly state: "available" }>;
  },
) {
  const [content, setContent] = useState<ContentState>({ kind: "loading" });
  const generation = useRef(0);
  const evidence = props.diff.observation.diff;
  const operationId = props.diff.observation.operationId;
  const threadId = props.diff.threadId;

  useEffect(() => {
    const request = ++generation.current;
    let active = true;
    setContent({ kind: "loading" });
    void props.client
      .operationContent(threadId, operationId, evidence.contentId)
      .then((bytes) => {
        let text: string;
        try {
          text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        } catch {
          throw new Error("Diff evidence is not valid UTF-8.");
        }
        if (active && request === generation.current) setContent({ kind: "ready", text });
      })
      .catch((error: unknown) => {
        if (!active || request !== generation.current) return;
        setContent({
          kind: "unavailable",
          message:
            error instanceof Error && error.message.trim().length > 0
              ? error.message
              : "Git diff evidence is unavailable.",
        });
      });
    return () => {
      active = false;
      generation.current += 1;
    };
  }, [evidence.contentId, operationId, props.client, threadId]);

  return (
    <section aria-label="Code diff" className="code-diff-pane">
      <header className="code-diff-pane__toolbar">
        <div>
          <span>Git diff</span>
          <h1>Checkout changes</h1>
        </div>
        <p>{props.diff.observation.changedPaths.length.toLocaleString()} changed paths</p>
      </header>

      {evidence.truncated === true ? (
        <div className="code-diff-pane__warning" role="alert">
          <strong>This diff is truncated and is not complete.</strong>
          <p>{evidence.byteLength.toLocaleString()} bytes retained</p>
        </div>
      ) : null}

      {content.kind === "loading" ? <p role="status">Loading diff evidence…</p> : null}
      {content.kind === "unavailable" ? <p role="alert">{content.message}</p> : null}
      {content.kind === "ready" ? (
        <MonacoEditorAdapter
          ariaLabel="Read-only Git diff"
          language="diff"
          {...(props.loadRuntime === undefined ? {} : { loadRuntime: props.loadRuntime })}
          modelUri={modelUri(props.diff.checkoutId, evidence.contentId)}
          onChange={() => undefined}
          readOnly
          value={content.text}
        />
      ) : null}
    </section>
  );
}

function modelUri(checkoutId: CodeCheckoutId, contentId: string): string {
  return `octant-code://${checkoutId}/diff/${contentId}`;
}
