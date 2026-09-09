import { useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { GitHistoryReader } from "@octant/plugin-api/git-history";
import type { CodeCheckoutId, CodeThreadId } from "@octant/contracts/code";
import type { GitHistoryPage, GitHistoryQuery } from "@octant/contracts/git-history";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantInput } from "../ui/base/OctantInput";
import { OctantSelectField } from "../ui/base/OctantSelect";
import { ShellState } from "../shell/ShellState";
import { CommitDetail } from "./CommitDetail";
import { layoutCommitGraph } from "./commitGraph";
import "./git-history.css";

export interface GitHistoryPanelProps {
  readonly reader: GitHistoryReader;
  readonly threadId: CodeThreadId;
  readonly checkoutId: CodeCheckoutId;
}

export function GitHistoryPanel(props: GitHistoryPanelProps) {
  return <BoundHistory key={`${props.threadId}:${props.checkoutId}`} {...props} />;
}

function BoundHistory(props: GitHistoryPanelProps) {
  const [page, setPage] = useState<GitHistoryPage>();
  const [revision, setRevision] = useState("HEAD");
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [refresh, setRefresh] = useState(0);
  const [busy, setBusy] = useState(true);
  const [message, setMessage] = useState<string>();
  const [selected, setSelected] = useState<string>();
  const selection = useRef<string | undefined>(undefined);
  const restoreFocus = useRef(false);
  const request = useRef<AbortController | undefined>(undefined);
  const scroller = useRef<HTMLDivElement>(null);
  const query = useMemo(
    (): Extract<GitHistoryQuery, { kind: "history" }> => ({
      kind: "history",
      threadId: props.threadId,
      checkoutId: props.checkoutId,
      ...(revision === "" ? {} : { revision }),
      ...(search === "" ? {} : { search }),
    }),
    [props.threadId, props.checkoutId, revision, search],
  );

  useEffect(() => {
    const controller = new AbortController();
    request.current?.abort();
    request.current = controller;
    setBusy(true);
    setPage(undefined);
    setMessage(undefined);
    setSelected(undefined);
    if (scroller.current) scroller.current.scrollTop = 0;
    props.reader
      .read(query, controller.signal)
      .then(
        (result) => {
          if (controller.signal.aborted) return;
          if (result.status === "history") setPage(result);
          else
            setMessage(
              result.status === "unavailable" ? result.message : "History returned no commits.",
            );
        },
        () => {
          if (!controller.signal.aborted)
            setMessage("Git history could not be loaded. Retry the request.");
        },
      )
      .finally(() => {
        if (!controller.signal.aborted) setBusy(false);
      });
    return () => {
      controller.abort();
      request.current?.abort();
    };
  }, [props.reader, query, refresh]);

  async function loadMore() {
    if (busy || page?.nextCursor == null) return;
    const controller = new AbortController();
    request.current?.abort();
    request.current = controller;
    setBusy(true);
    setMessage(undefined);
    try {
      const result = await props.reader.read(
        { ...query, cursor: page.nextCursor },
        controller.signal,
      );
      if (controller.signal.aborted) return;
      if (result.status === "history")
        setPage((previous) =>
          previous === undefined
            ? result
            : { ...result, commits: [...previous.commits, ...result.commits] },
        );
      else
        setMessage(
          result.status === "unavailable" ? result.message : "Older commits could not be loaded.",
        );
    } catch {
      if (!controller.signal.aborted)
        setMessage("Older commits could not be loaded. Retry the request.");
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  }

  const commits = page?.commits ?? [];
  const graph = useMemo(() => layoutCommitGraph(commits), [commits]);
  const lanes = Math.max(1, ...graph.map((row) => row.width));
  const graphWidth = search === "" ? Math.min(160, Math.max(48, lanes * 14 + 20)) : 48;
  const spacing = Math.min(14, (graphWidth - 20) / Math.max(1, lanes - 1));
  const virtual = useVirtualizer({
    count: commits.length,
    getScrollElement: () => scroller.current,
    estimateSize: () => 40,
    overscan: 12,
    initialRect: { width: 640, height: 480 },
  });
  const rows = virtual.getVirtualItems();
  useEffect(() => {
    if (selected !== undefined || !restoreFocus.current) return;
    const button = scroller.current?.querySelector<HTMLButtonElement>(
      `[data-commit="${selection.current ?? ""}"]`,
    );
    if (button) {
      button.focus();
      restoreFocus.current = false;
    }
  }, [selected, rows]);

  const options = [
    { id: "HEAD", label: "Current branch" },
    { id: "", label: "All branches" },
    ...(page?.refs ?? []).map((ref) => ({
      id: ref.name,
      label:
        ref.name.replace(/^refs\/(heads|remotes|tags)\//, "") +
        (ref.kind === "tag" ? " (tag)" : ""),
    })),
  ];
  return (
    <section className="git-history" aria-label="Git history">
      <div className="git-history__list" hidden={selected !== undefined}>
        <div className="git-history__toolbar">
          <OctantSelectField
            aria-label="History branch"
            value={revision}
            onValueChange={setRevision}
            options={options}
          />
          <OctantButton
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={() => setRefresh((value) => value + 1)}
          >
            Refresh
          </OctantButton>
        </div>
        <form
          className="git-history__search"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            setSearch(searchInput.trim());
          }}
        >
          <OctantInput
            aria-label="Search commit history"
            placeholder="Message, author, or SHA"
            value={searchInput}
            maxLength={200}
            onChange={(event) => setSearchInput(event.target.value)}
          />
          <OctantButton type="submit" size="sm" variant="outline" disabled={busy}>
            Search
          </OctantButton>
          {search === "" ? null : (
            <OctantButton
              size="sm"
              variant="ghost"
              onClick={() => {
                setSearch("");
                setSearchInput("");
              }}
            >
              Clear
            </OctantButton>
          )}
        </form>
        <div className="git-history__status" role="status">
          {busy
            ? "Loading commits…"
            : `${commits.length.toLocaleString()} ${search === "" ? (commits.length === 1 ? "commit" : "commits") : commits.length === 1 ? "match" : "matches"} loaded`}
          {page?.branch ? ` · ${page.branch}` : page?.head ? " · Detached HEAD" : ""}
        </div>
        {page?.shallow ? (
          <p className="git-history__notice">
            This is a shallow clone. Earlier history may be missing.
          </p>
        ) : null}
        {page?.refsTruncated ? (
          <p className="git-history__notice">Some repository refs are outside the history limit.</p>
        ) : null}
        {message === undefined ? null : (
          <div className="git-history__notice" role="alert">
            {message}{" "}
            <OctantButton
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() =>
                page?.nextCursor ? void loadMore() : setRefresh((value) => value + 1)
              }
            >
              Retry
            </OctantButton>
          </div>
        )}
        {page === undefined && busy ? <ShellState state="loading" title="Loading history" /> : null}
        {page !== undefined && commits.length === 0 ? (
          <p className="git-history__notice">
            {search !== ""
              ? "No matches in the scanned history."
              : "This branch has no commits yet."}
          </p>
        ) : null}
        <div className="git-history__scroller" ref={scroller}>
          <table className="git-history__table" aria-label="Commits">
            <thead>
              <tr>
                <th scope="col" style={{ width: graphWidth }}>
                  Graph
                </th>
                <th scope="col">Commit</th>
                <th scope="col" className="git-history__author">
                  Author
                </th>
                <th scope="col" className="git-history__date">
                  Date
                </th>
                <th scope="col" className="git-history__sha">
                  SHA
                </th>
              </tr>
            </thead>
            <tbody>
              {rows[0] && rows[0].start > 0 ? (
                <tr aria-hidden="true">
                  <td colSpan={1} style={{ height: rows[0].start, padding: 0 }} />
                </tr>
              ) : null}
              {rows.map((row) => {
                const commit = commits[row.index];
                const drawing = graph[row.index];
                if (commit === undefined || drawing === undefined) return null;

                return (
                  <tr key={commit.oid} data-selected={selection.current === commit.oid}>
                    <td className="git-history__graph">
                      <svg aria-hidden="true" width={graphWidth} height={40}>
                        {search === ""
                          ? drawing.edges.map((edge, index) => (
                              <path
                                key={index}
                                data-lane={edge.toLane % 4}
                                d={`M ${10 + edge.fromLane * spacing} ${edge.from * 40} L ${10 + edge.toLane * spacing} ${edge.to * 40}`}
                              />
                            ))
                          : null}
                        <circle
                          data-lane={drawing.lane % 4}
                          cx={search === "" ? 10 + drawing.lane * spacing : 10}
                          cy={20}
                          r={commit.oid === page?.head ? 4 : 3}
                        />
                      </svg>
                    </td>
                    <td className="git-history__subject">
                      <OctantButton
                        className="git-history__commit"
                        variant="ghost"
                        data-commit={commit.oid}
                        onClick={() => {
                          selection.current = commit.oid;
                          setSelected(commit.oid);
                        }}
                        title={`${commit.subject}\n${commit.parents.length} ${commit.parents.length === 1 ? "parent" : "parents"}`}
                        aria-label={`Open commit ${commit.oid.slice(0, 7)}: ${commit.subject}`}
                      >
                        {commit.subject}
                      </OctantButton>
                      <span className="git-history__refs">
                        {(page?.refs ?? [])
                          .filter((ref) => ref.oid === commit.oid)
                          .map((ref) => (
                            <span key={ref.name} title={ref.name}>
                              {ref.name.replace(/^refs\/(heads|remotes|tags)\//, "")}
                            </span>
                          ))}
                      </span>
                    </td>
                    <td className="git-history__author" title={commit.author}>
                      {commit.author}
                    </td>
                    <td className="git-history__date">
                      <time dateTime={commit.authoredAt} title={commit.authoredAt}>
                        {new Date(commit.authoredAt).toLocaleDateString(undefined, {
                          month: "short",
                          day: "numeric",
                        })}
                      </time>
                    </td>
                    <td className="git-history__sha">{commit.oid.slice(0, 7)}</td>
                  </tr>
                );
              })}
              {rows.length > 0 ? (
                <tr aria-hidden="true">
                  <td
                    colSpan={1}
                    style={{
                      height: Math.max(0, virtual.getTotalSize() - (rows.at(-1)?.end ?? 0)),
                      padding: 0,
                    }}
                  />
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
        {page?.nextCursor == null ? null : (
          <div className="git-history__more">
            <OctantButton
              variant="ghost"
              disabled={busy || commits.length >= 5000}
              onClick={() => void loadMore()}
            >
              {busy ? "Loading…" : "Load older commits"}
            </OctantButton>
            {commits.length >= 5000 ? (
              <p>Showing 5,000 commits. Choose a branch or search to narrow history.</p>
            ) : null}
          </div>
        )}
      </div>
      {selected === undefined ? null : (
        <CommitDetail
          reader={props.reader}
          threadId={props.threadId}
          checkoutId={props.checkoutId}
          oid={selected}
          onBack={() => {
            restoreFocus.current = true;
            setSelected(undefined);
          }}
        />
      )}
    </section>
  );
}
