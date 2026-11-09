import { useEffect, useRef, useState } from "react";
import type { CodeClient } from "@octant/client-runtime/code-client";
import {
  decodeCodeRelativePath,
  type CodeCheckoutId,
  type CodeThreadId,
} from "@octant/contracts/code";
import type { ProviderFileReviewRead } from "@octant/contracts/provider-file-review";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantSelectField } from "../ui/base/OctantSelect";
import { OctantAlert } from "../ui/base/OctantAlert";
import { ShellState } from "../shell/ShellState";
import { MonacoDiffAdapter } from "./MonacoDiffAdapter";
import type { MonacoDiffRuntime } from "./MonacoEditorAdapter";

type Reader = NonNullable<CodeClient["readProviderFileReview"]>;
const refusal: Readonly<
  Record<Extract<ProviderFileReviewRead, { status: "refused" }>["reason"], string>
> = {
  unsupported: "This provider runtime does not support checkpoint reads.",
  "no-session": "This thread has no saved provider session to read.",
  "turn-running": "The provider session is busy. Try again when it finishes.",
  stale: "The session, file or access changed. Read the checkpoint again.",
  unavailable: "The provider checkpoint could not be read. Try again.",
  malformed: "The provider returned an unreadable checkpoint.",
  "too-large": "This checkpoint exceeds the readable size limit.",
  "path-refused": "This file is outside the session's readable files.",
  unauthorized: "Access to this checkpoint is no longer available.",
  "cold-unavailable": "The provider could not reopen this saved session.",
  cancelled: "The checkpoint read was cancelled.",
  timeout: "The checkpoint read timed out. Try again.",
};

export function CodeProviderFileReview(props: {
  readonly read: Reader;
  readonly threadId: CodeThreadId;
  readonly checkoutId: CodeCheckoutId;
  readonly path: string;
  readonly onClose: () => void;
  readonly loadRuntime?: () => Promise<MonacoDiffRuntime>;
}) {
  const [result, setResult] = useState<ProviderFileReviewRead>();
  const [scopeId, setScopeId] = useState<string>();
  const [revision, setRevision] = useState(0);
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    heading.current?.focus();
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    setResult(undefined);
    let path;
    try {
      path = decodeCodeRelativePath(props.path);
    } catch {
      setResult({ status: "refused", reason: "path-refused" });
      return;
    }
    void props
      .read(
        {
          kind: "file",
          threadId: props.threadId,
          checkoutId: props.checkoutId,
          path,
          ...(scopeId === undefined ? {} : { scopeId }),
        },
        controller.signal,
      )
      .then((answer) => {
        if (active && !controller.signal.aborted)
          setResult(
            answer.status === "available"
              ? { status: "refused", reason: "malformed" }
              : answer.status === "ready" && answer.file.path !== props.path
                ? { status: "refused", reason: "stale" }
                : answer,
          );
      })
      .catch(() => {
        if (active && !controller.signal.aborted)
          setResult({ status: "refused", reason: "unavailable" });
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [props.read, props.threadId, props.checkoutId, props.path, scopeId, revision]);
  const comparison = result?.status === "ready" ? result.file.comparison : undefined;
  return (
    <section
      className="code-provider-file-review"
      aria-label={`Provider checkpoint for ${props.path}`}
    >
      <header>
        <h2 ref={heading} tabIndex={-1}>
          Provider checkpoint · {props.path}
        </h2>
        <OctantButton type="button" size="sm" variant="ghost" onClick={props.onClose}>
          Close checkpoint
        </OctantButton>
      </header>
      <p>Supplementary session history. Git remains the checkout comparison.</p>
      {result === undefined ? (
        <ShellState state="loading" title="Reading provider checkpoint" />
      ) : result.status === "refused" ? (
        <OctantAlert
          tone="warning"
          action={
            <OctantButton
              type="button"
              size="sm"
              variant="outline"
              onClick={() => {
                setScopeId(undefined);
                setRevision((value) => value + 1);
              }}
            >
              Read again
            </OctantButton>
          }
        >
          {refusal[result.reason]}
        </OctantAlert>
      ) : (
        <>
          {result.file.scopes.length === 0 ? (
            <p role="status">
              No recorded edit scopes for this file. The session checkpoint is available below.
            </p>
          ) : (
            <OctantSelectField
              aria-label="Provider edit scope"
              options={result.file.scopes}
              value={comparison?.scopeId ?? ""}
              onValueChange={setScopeId}
            />
          )}
          {comparison === undefined ? null : comparison.change === "opaque" ? (
            <p role="status">This scope has no readable text comparison.</p>
          ) : (
            <div className="code-provider-file-review__comparison">
              <MonacoDiffAdapter
                ariaLabel={`Provider scope for ${props.path}`}
                modelUriBase={`octant-provider-review://${props.threadId}/${encodeURIComponent(props.path)}/${encodeURIComponent(comparison.scopeId)}`}
                language="plaintext"
                original={comparison.before}
                modified={comparison.after}
                renderSideBySide={false}
                {...(props.loadRuntime === undefined ? {} : { loadRuntime: props.loadRuntime })}
              />
            </div>
          )}
          <details>
            <summary>Session checkpoint</summary>
            {result.file.checkpoint.length === 0 ? (
              <p>The checkpoint is empty.</p>
            ) : (
              <pre>{result.file.checkpoint}</pre>
            )}
          </details>
          {result.file.anchors.length === 0 ? null : (
            <p className="code-provider-file-review__anchors">
              Scope anchors:{" "}
              {result.file.anchors.map((anchor) => `${anchor.side} line ${anchor.line}`).join(", ")}
            </p>
          )}
        </>
      )}
    </section>
  );
}
