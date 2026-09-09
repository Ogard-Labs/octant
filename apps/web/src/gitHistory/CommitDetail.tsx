import { lazy, Suspense, useEffect, useMemo, useState, useRef } from "react";
import type { GitHistoryClient } from "@octant/client-runtime/git-history-client";
import type { CodeCheckoutId, CodeThreadId } from "@octant/contracts/code";
import type { GitHistoryDetail } from "@octant/contracts/git-history";
import { parseUnifiedDiff, type ParsedDiffFile } from "../code/unifiedDiff";
import { UnifiedDiffList } from "../code/UnifiedDiffList";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantSelectField } from "../ui/base/OctantSelect";
import { OctantToggleGroup, OctantToggleGroupItem } from "../ui/base/OctantToggleGroup";
import { ShellState } from "../shell/ShellState";

const MonacoDiffAdapter = lazy(() =>
  import("../code/MonacoDiffAdapter").then((module) => ({ default: module.MonacoDiffAdapter })),
);
export function CommitDetail(props: {
  readonly reader: GitHistoryClient;
  readonly threadId: CodeThreadId;
  readonly checkoutId: CodeCheckoutId;
  readonly oid: string;
  readonly onBack: () => void;
}) {
  const [parent, setParent] = useState(0);
  const back = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    back.current?.focus();
  }, []);
  const [detail, setDetail] = useState<GitHistoryDetail>();
  const [message, setMessage] = useState<string>();
  const [retry, setRetry] = useState(0);
  const [layout, setLayout] = useState("unified");
  const [fileId, setFileId] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    setDetail(undefined);
    setMessage(undefined);
    props.reader
      .read(
        {
          kind: "commit",
          threadId: props.threadId,
          checkoutId: props.checkoutId,
          oid: props.oid,
          parent,
        },
        controller.signal,
      )
      .then(
        (result) => {
          if (controller.signal.aborted) return;
          if (result.status === "commit") setDetail(result);
          else
            setMessage(
              result.status === "unavailable" ? result.message : "The commit could not be loaded.",
            );
        },
        () => {
          if (!controller.signal.aborted)
            setMessage("The commit could not be loaded. Retry the request.");
        },
      );
    return () => controller.abort();
  }, [props.reader, props.threadId, props.checkoutId, props.oid, parent, retry]);
  const files = useMemo(() => parseUnifiedDiff(detail?.diff ?? ""), [detail?.diff]);
  const selected = files.find((file) => file.id === fileId) ?? files[0];
  return (
    <section className="git-history__detail" aria-label="Commit details">
      <div className="git-history__toolbar">
        <OctantButton variant="ghost" size="sm" ref={back} onClick={props.onBack}>
          Back to history
        </OctantButton>
        <code title={props.oid}>{props.oid.slice(0, 10)}</code>
      </div>
      {message === undefined ? null : (
        <div className="git-history__notice" role="alert">
          {message}
          <OctantButton variant="ghost" onClick={() => setRetry((value) => value + 1)}>
            Retry
          </OctantButton>
        </div>
      )}
      {detail === undefined ? (
        message === undefined ? (
          <ShellState state="loading" title="Loading commit" />
        ) : null
      ) : (
        <>
          <header className="git-history__commit-header">
            <h2>{detail.commit.subject}</h2>
            <p>
              {detail.commit.author} ·{" "}
              <time dateTime={detail.commit.authoredAt}>
                {new Date(detail.commit.authoredAt).toLocaleString()}
              </time>
            </p>
            {detail.message.trim() === detail.commit.subject ? null : (
              <details className="git-history__message">
                <summary>Commit message</summary>
                <pre>
                  {detail.message.startsWith(detail.commit.subject)
                    ? detail.message.slice(detail.commit.subject.length).trimStart()
                    : detail.message}
                </pre>
              </details>
            )}
            <p>
              {detail.files.toLocaleString()} changed files{" "}
              <span className="git-history__additions">+{detail.insertions.toLocaleString()}</span>{" "}
              <span className="git-history__deletions">−{detail.deletions.toLocaleString()}</span>
            </p>
            {detail.commit.parents.length > 1 ? (
              <OctantSelectField
                aria-label="Compare with parent"
                value={String(parent)}
                onValueChange={(value) => setParent(Number(value))}
                options={detail.commit.parents.map((oid, index) => ({
                  id: String(index),
                  label: `Parent ${index + 1} · ${oid.slice(0, 7)}`,
                }))}
              />
            ) : (
              <p>
                {detail.parent === null
                  ? "First commit"
                  : `Compared with ${detail.parent.slice(0, 10)}`}
              </p>
            )}
          </header>
          {detail.truncated ? (
            <p className="git-history__notice" role="note">
              This commit exceeds the preview limit. The diff or message is incomplete; totals
              describe the full change.
            </p>
          ) : null}
          {files.length === 0 ? (
            <p className="git-history__notice">No file changes against this parent.</p>
          ) : (
            <>
              <div className="git-history__toolbar">
                <OctantToggleGroup
                  aria-label="Diff layout"
                  value={[layout]}
                  onValueChange={(values) => {
                    const value = values[0];
                    if (value) setLayout(value);
                  }}
                >
                  <OctantToggleGroupItem value="unified">Unified</OctantToggleGroupItem>
                  <OctantToggleGroupItem value="split">Side by side</OctantToggleGroupItem>
                </OctantToggleGroup>
              </div>
              {layout === "unified" ? (
                <div className="git-history__diffs">
                  {files.map((file, index) => (
                    <CommitFileDiff key={file.id} file={file} initiallyOpen={index < 5} />
                  ))}
                </div>
              ) : selected === undefined ? null : (
                <div className="git-history__split">
                  <OctantSelectField
                    aria-label="Changed file"
                    value={selected.id}
                    onValueChange={setFileId}
                    options={files.map((file) => ({ id: file.id, label: file.path }))}
                  />
                  <p>Changed regions only. Unchanged parts of the file are omitted.</p>
                  {selected.binary ? (
                    <p>This file has no textual diff.</p>
                  ) : (
                    <Suspense fallback={<ShellState state="loading" title="Loading comparison" />}>
                      <MonacoDiffAdapter
                        ariaLabel={`Diff for ${selected.path}`}
                        language="plaintext"
                        modelUriBase={`octant-code://history/${props.threadId}/${props.checkoutId}/${props.oid}/${parent}/${encodeURIComponent(selected.path)}`}
                        original={selected.original}
                        modified={selected.modified}
                        renderSideBySide
                      />
                    </Suspense>
                  )}
                </div>
              )}
            </>
          )}
        </>
      )}
    </section>
  );
}

function CommitFileDiff(props: { readonly file: ParsedDiffFile; readonly initiallyOpen: boolean }) {
  const [open, setOpen] = useState(props.initiallyOpen);
  const lineCount = props.file.hunks.reduce((total, hunk) => total + hunk.lines.length, 0);
  let remaining = 2000;
  const visible: ParsedDiffFile = {
    ...props.file,
    hunks: props.file.hunks.flatMap((hunk) => {
      if (remaining === 0) return [];
      const lines = hunk.lines.slice(0, remaining);
      remaining -= lines.length;
      return [{ ...hunk, lines }];
    }),
  };
  return (
    <details open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>
        {props.file.path}{" "}
        <span>
          {props.file.binary
            ? "No textual diff"
            : `+${props.file.additions} −${props.file.deletions}`}
        </span>
      </summary>
      {open ? (
        <>
          <UnifiedDiffList files={[visible]} />
          {lineCount > 2000 ? (
            <p className="git-history__notice">
              Showing the first 2,000 diff lines. Use Side by side to inspect the full available
              preview.
            </p>
          ) : null}
        </>
      ) : null}
    </details>
  );
}
