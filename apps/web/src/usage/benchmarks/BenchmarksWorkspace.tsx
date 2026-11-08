import { Download, Pencil, Plus, RefreshCw, Trash2, Upload } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  decodeBenchmarkCellId,
  decodeBenchmarkRunId,
  type BenchmarkRunReadResponse,
  type BenchmarkRunStartRequest,
  type BenchmarkRunSummary,
  type BenchmarkSuite,
  type BenchmarkSuiteSaveRequest,
  type ProviderInstance,
  type TurnDiagnosticsReport,
} from "@octant/contracts";
import {
  BenchmarksClientError,
  type BenchmarksClient,
  type ChatClient,
  type UsageClient,
} from "@octant/client-runtime";
import type { ProviderRegistrySnapshot } from "@octant/contracts/providers";
import { OctantAlert } from "../../ui/base/OctantAlert";
import { OctantButton } from "../../ui/base/OctantButton";
import { OctantConfirmDialog } from "../../ui/base/OctantConfirmDialog";
import { OctantTextarea } from "../../ui/base/OctantTextarea";
import { Surface, SurfaceEmpty, SurfaceHeader, SurfaceSection } from "../../surface/SurfaceHeader";
import { BenchmarkCaseCompare } from "./BenchmarkCaseCompare";
import { BenchmarkLeaderboard } from "./BenchmarkLeaderboard";
import { BenchmarkLiveGrid } from "./BenchmarkLiveGrid";
import { BenchmarkRunBuilder } from "./BenchmarkRunBuilder";
import { BenchmarkSuiteEditor, type CodeProjectChoice } from "./BenchmarkSuiteEditor";
import { contenderNames, modelChoices } from "./benchmarkModels";
import {
  blankSuiteDraft,
  exportFileName,
  exportSuiteJson,
  importSuiteJson,
  nameForImportedSuite,
  READ_ONLY_WINDOW_SENTENCE,
  RUN_STATUS_WORDS,
  suiteToDraft,
  type SuiteDraft,
} from "./benchmarkPresentation";
import "../usageWorkspace.css";
import "../turnDiagnostics.css";
import "./benchmarks.css";

/** How often a running run is read again. */
export const BENCHMARK_POLL_MS = 3_000;

export interface BenchmarksWorkspaceProps {
  readonly client: BenchmarksClient;
  /** Prices the estimate from earlier turns; without it the estimate says it has none. */
  readonly diagnosticsClient?: Pick<UsageClient, "diagnostics">;
  /** Reads the answers from each cell's thread. */
  readonly chatClient?: Pick<ChatClient, "thread">;
  readonly providers?: ReadonlyArray<ProviderInstance>;
  readonly providerSnapshot?: ProviderRegistrySnapshot | undefined;
  /** The Code Projects a Code case may name. */
  readonly codeProjects?: ReadonlyArray<CodeProjectChoice>;
  readonly sourceControl?: ReactNode;
  readonly onBack?: () => void;
  readonly onOpenSubject?: (subjectType: string, subjectId: string) => void;
  /** Inside Settings: no page title or back button. */
  readonly embedded?: boolean;
  readonly pollIntervalMs?: number;
  /** Hands the exported file to the person; defaults to a browser download. */
  readonly saveFile?: (fileName: string, text: string) => void;
}

type LoadState =
  | { readonly status: "loading" }
  | {
      readonly status: "ready";
      readonly suites: ReadonlyArray<BenchmarkSuite>;
      readonly runs: ReadonlyArray<BenchmarkRunSummary>;
    }
  | { readonly status: "failure"; readonly message: string };

type Pending =
  | { readonly kind: "delete-suite"; readonly suite: BenchmarkSuite }
  | { readonly kind: "purge-run"; readonly run: BenchmarkRunSummary };

function downloadText(fileName: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  URL.revokeObjectURL(url);
}

function readFileText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : "");
    reader.onerror = () => reject(new Error("The file could not be read."));
    reader.readAsText(file);
  });
}

/** A refusal in words: a local-window-only write says whose window may do it. */
function refusalSentence(error: unknown, fallback: string): string {
  if (error instanceof BenchmarksClientError) {
    return error.status === 403 ? READ_ONLY_WINDOW_SENTENCE : error.message;
  }
  return fallback;
}

function formatWhen(timestamp: string): string {
  return new Date(timestamp).toLocaleString();
}

/**
 * Model benchmarks: write a suite, pick who competes, watch the run fill in,
 * and compare what each model answered. The host measures and scores; this
 * page only reads and words it. Writes are local-window only on the host, and
 * a refusal there is stated as such rather than shown as a broken button.
 */
export function BenchmarksWorkspace(props: BenchmarksWorkspaceProps) {
  const { client } = props;
  const pollMs = props.pollIntervalMs ?? BENCHMARK_POLL_MS;
  const [load, setLoad] = useState<LoadState>({ status: "loading" });
  const [selectedSuiteId, setSelectedSuiteId] = useState<string | undefined>(undefined);
  const [editing, setEditing] = useState<SuiteDraft | undefined>(undefined);
  const [selectedRunId, setSelectedRunId] = useState<string | undefined>(undefined);
  const [runRead, setRunRead] = useState<BenchmarkRunReadResponse | undefined>(undefined);
  const [selectedCaseId, setSelectedCaseId] = useState<string | undefined>(undefined);
  const [report, setReport] = useState<TurnDiagnosticsReport | undefined>(undefined);
  const [notice, setNotice] = useState<string | undefined>(undefined);
  // Why the run in view could not be read; a later successful read clears it.
  const [readNotice, setReadNotice] = useState<string | undefined>(undefined);
  const [importOpen, setImportOpen] = useState(false);
  const [pasted, setPasted] = useState("");
  const [importError, setImportError] = useState<string | undefined>(undefined);
  const [pending, setPending] = useState<Pending | undefined>(undefined);
  const [working, setWorking] = useState(false);
  const [cancelling, setCancelling] = useState(false);

  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const names = useMemo(
    () => contenderNames(props.providers, props.providerSnapshot),
    [props.providers, props.providerSnapshot],
  );
  const models = useMemo(() => modelChoices(props.providerSnapshot), [props.providerSnapshot]);
  // Contenders of a suite with Code cases must be able to run in Code, so they
  // come from the Code picker policy rather than the Chat one.
  const codeModels = useMemo(
    () => modelChoices(props.providerSnapshot, "code"),
    [props.providerSnapshot],
  );

  const reload = useCallback(async () => {
    try {
      const [suites, runs] = await Promise.all([client.listSuites(), client.listRuns({})]);
      if (!mounted.current) return;
      setLoad({
        status: "ready",
        suites: suites.suites,
        runs: [...runs.runs].sort((left, right) => right.startedAt.localeCompare(left.startedAt)),
      });
    } catch (error) {
      if (mounted.current) {
        setLoad({
          status: "failure",
          message: refusalSentence(error, "Benchmarks could not be loaded."),
        });
      }
    }
  }, [client]);

  useEffect(() => {
    void reload();
  }, [reload]);

  // The estimate's price list: what each model's earlier turns cost.
  const diagnostics = props.diagnosticsClient;
  useEffect(() => {
    if (diagnostics === undefined) return;
    let current = true;
    diagnostics.diagnostics({ bucket: "day" }).then(
      (read) => {
        if (current) setReport(read);
      },
      () => undefined,
    );
    return () => {
      current = false;
    };
  }, [diagnostics]);

  // The run in view is read when chosen and again every poll while it runs.
  const readToken = useRef(0);
  const readRun = useCallback(
    async (runId: string) => {
      const token = ++readToken.current;
      try {
        const read = await client.readRun({ runId: decodeBenchmarkRunId(runId) });
        if (!mounted.current || token !== readToken.current) return;
        setRunRead(read);
        setReadNotice(undefined);
        if (read.run.status !== "running") void reload();
      } catch (error) {
        if (mounted.current && token === readToken.current) {
          setReadNotice(refusalSentence(error, "The run could not be read."));
        }
      }
    },
    [client, reload],
  );

  useEffect(() => {
    if (selectedRunId === undefined) {
      readToken.current += 1;
      setRunRead(undefined);
      return;
    }
    void readRun(selectedRunId);
  }, [selectedRunId, readRun]);

  const runStatus = runRead?.run.status;
  useEffect(() => {
    if (selectedRunId === undefined || runStatus !== "running") return;
    // Each read is scheduled after the last one settles, so a slow host never
    // gets overlapping reads of the same run.
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const next = async () => {
      await readRun(selectedRunId);
      if (!stopped) timer = setTimeout(() => void next(), pollMs);
    };
    timer = setTimeout(() => void next(), pollMs);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [selectedRunId, runStatus, pollMs, readRun]);

  const suites = load.status === "ready" ? load.suites : [];
  const runs = load.status === "ready" ? load.runs : [];
  const selectedSuite = suites.find((suite) => String(suite.suiteId) === selectedSuiteId);
  const suiteRuns = runs.filter((run) => String(run.suiteId) === selectedSuiteId);
  const knownSuites = new Set(suites.map((suite) => String(suite.suiteId)));
  const orphanRuns = runs.filter((run) => !knownSuites.has(String(run.suiteId)));
  const metricsByCell = useMemo(
    () =>
      new Map((runRead?.cellMetrics ?? []).map((entry) => [String(entry.cellId), entry.metrics])),
    [runRead],
  );

  const runsTable = (list: typeof runs, tableLabel: string) => (
    <div className="usage-table-scroll">
      <table aria-label={tableLabel} className="usage-table">
        <thead>
          <tr>
            <th scope="col">Started</th>
            <th scope="col">Status</th>
            <th scope="col">Contenders</th>
            <th scope="col">Cells settled</th>
            <th scope="col">
              <span className="benchmark-visually-hidden">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {list.map((run) => (
            <tr key={String(run.runId)}>
              <th scope="row">
                <OctantButton
                  variant="bare"
                  aria-pressed={String(run.runId) === selectedRunId}
                  className="benchmark-link"
                  onClick={() => {
                    setSelectedCaseId(undefined);
                    setSelectedRunId(String(run.runId));
                  }}
                  type="button"
                >
                  {formatWhen(run.startedAt)}
                </OctantButton>
              </th>
              <td>{RUN_STATUS_WORDS[run.status]}</td>
              <td>
                {run.contenderCount}
                {run.repetitions > 1 ? ` × ${run.repetitions}` : ""}
              </td>
              <td>
                {run.settledCount} of {run.cellCount}
              </td>
              <td className="benchmark-actions">
                <OctantButton
                  aria-label={`Purge the run from ${formatWhen(run.startedAt)}`}
                  disabled={run.status === "running"}
                  onClick={() => setPending({ kind: "purge-run", run })}
                  size="icon"
                  type="button"
                  variant="ghost"
                >
                  <Trash2 aria-hidden="true" size={14} />
                </OctantButton>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );

  const saveSuite = async (request: BenchmarkSuiteSaveRequest): Promise<string | undefined> => {
    try {
      const saved = await client.saveSuite(request);
      if (!mounted.current) return undefined;
      setEditing(undefined);
      setSelectedSuiteId(String(saved.suite.suiteId));
      setNotice(`Saved "${saved.suite.name}".`);
      await reload();
      return undefined;
    } catch (error) {
      return refusalSentence(error, "The suite could not be saved.");
    }
  };

  const startRun = async (request: BenchmarkRunStartRequest): Promise<string | undefined> => {
    try {
      const started = await client.startRun(request);
      if (!mounted.current) return undefined;
      setNotice(undefined);
      setSelectedCaseId(undefined);
      setSelectedRunId(String(started.run.runId));
      await reload();
      return undefined;
    } catch (error) {
      return refusalSentence(error, "The run could not be started.");
    }
  };

  const rateCell = async (
    cellId: string,
    stars: number,
    note: string | undefined,
  ): Promise<string | undefined> => {
    if (runRead === undefined) return undefined;
    try {
      await client.rateCell({
        runId: runRead.run.runId,
        cellId: decodeBenchmarkCellId(cellId),
        stars,
        ...(note === undefined ? {} : { note }),
      });
      await readRun(String(runRead.run.runId));
      return undefined;
    } catch (error) {
      return refusalSentence(error, "The rating could not be saved.");
    }
  };

  const cancelRun = async () => {
    if (runRead === undefined) return;
    setCancelling(true);
    try {
      await client.cancelRun({ runId: runRead.run.runId });
      await readRun(String(runRead.run.runId));
    } catch (error) {
      if (mounted.current) setNotice(refusalSentence(error, "The run could not be cancelled."));
    } finally {
      if (mounted.current) setCancelling(false);
    }
  };

  const confirmPending = async () => {
    if (pending === undefined) return;
    setWorking(true);
    try {
      if (pending.kind === "delete-suite") {
        await client.deleteSuite({ suiteId: pending.suite.suiteId });
        if (!mounted.current) return;
        if (String(pending.suite.suiteId) === selectedSuiteId) setSelectedSuiteId(undefined);
        setNotice(`Deleted "${pending.suite.name}". Its finished runs stay until purged.`);
      } else {
        await client.purgeRun({ runId: pending.run.runId });
        if (!mounted.current) return;
        if (String(pending.run.runId) === selectedRunId) setSelectedRunId(undefined);
        setNotice("Purged the run and its threads.");
      }
      setPending(undefined);
      await reload();
    } catch (error) {
      if (mounted.current) {
        setNotice(
          refusalSentence(
            error,
            pending.kind === "delete-suite"
              ? "The suite could not be deleted."
              : "The run could not be purged.",
          ),
        );
        setPending(undefined);
      }
    } finally {
      if (mounted.current) setWorking(false);
    }
  };

  const importText = (text: string) => {
    const result = importSuiteJson(text);
    if (result.status === "invalid") {
      setImportError(result.message);
      return;
    }
    setImportError(undefined);
    setImportOpen(false);
    setPasted("");
    setEditing({
      ...result.draft,
      name: nameForImportedSuite(
        result.draft.name,
        suites.map((existing) => existing.name),
      ),
    });
  };

  const exportSuite = (suite: BenchmarkSuite) =>
    (props.saveFile ?? downloadText)(exportFileName(suite), exportSuiteJson(suite));

  const actions = (
    <>
      {props.sourceControl}
      <OctantButton
        aria-label="Refresh benchmarks"
        onClick={() => {
          void reload();
          if (selectedRunId !== undefined) void readRun(selectedRunId);
        }}
        size="icon"
        type="button"
        variant="ghost"
      >
        <RefreshCw aria-hidden="true" size={14} />
      </OctantButton>
    </>
  );

  const lastRunOf = (suite: BenchmarkSuite): BenchmarkRunSummary | undefined =>
    runs.find((run) => String(run.suiteId) === String(suite.suiteId));

  const body = (
    <>
      {props.embedded === true ? (
        <div className="turn-diagnostics__toolbar">{actions}</div>
      ) : (
        <SurfaceHeader
          actions={actions}
          {...(props.onBack === undefined ? {} : { onBack: props.onBack })}
          detail="Same prompts, different models"
          title="Benchmarks"
        />
      )}

      {readNotice === undefined ? null : (
        <p aria-live="polite" className="usage-workspace__status" role="status">
          {readNotice}
        </p>
      )}
      {notice === undefined ? null : (
        <p aria-live="polite" className="usage-workspace__status" role="status">
          {notice}
        </p>
      )}
      {load.status === "failure" ? (
        <OctantAlert tone="warning">
          <p>{load.message}</p>
          <OctantButton onClick={() => void reload()} type="button">
            Retry
          </OctantButton>
        </OctantAlert>
      ) : null}
      {load.status === "loading" ? (
        <p aria-live="polite" className="usage-workspace__status" role="status">
          Loading benchmarks…
        </p>
      ) : null}

      {editing !== undefined ? (
        <BenchmarkSuiteEditor
          codeProjects={props.codeProjects ?? []}
          initial={editing}
          models={models}
          onCancel={() => setEditing(undefined)}
          onSave={saveSuite}
        />
      ) : load.status !== "ready" ? null : (
        <SurfaceSection
          actions={
            <>
              <OctantButton
                onClick={() => {
                  setNotice(undefined);
                  setEditing(blankSuiteDraft());
                }}
                size="sm"
                type="button"
                variant="ghost"
              >
                <Plus aria-hidden="true" size={14} />
                New suite
              </OctantButton>
              <OctantButton
                aria-expanded={importOpen}
                onClick={() => setImportOpen((open) => !open)}
                size="sm"
                type="button"
                variant="ghost"
              >
                <Upload aria-hidden="true" size={14} />
                Import suite
              </OctantButton>
            </>
          }
          label="Suites"
        >
          {importOpen ? (
            <div aria-label="Import a suite" className="benchmark-import" role="group">
              <label className="usage-workspace__field">
                <span>Suite file</span>
                <input
                  accept="application/json,.json"
                  aria-label="Suite file"
                  onChange={(event) => {
                    const file = event.currentTarget.files?.[0];
                    if (file === undefined) return;
                    void readFileText(file).then(importText, (error: unknown) =>
                      setImportError(error instanceof Error ? error.message : "Unreadable file."),
                    );
                  }}
                  type="file"
                />
              </label>
              <label className="usage-workspace__field">
                <span>Or paste the suite JSON</span>
                <OctantTextarea
                  aria-label="Pasted suite JSON"
                  onChange={(event) => setPasted(event.currentTarget.value)}
                  rows={5}
                  value={pasted}
                />
              </label>
              <div>
                <OctantButton
                  disabled={pasted.trim() === ""}
                  onClick={() => importText(pasted)}
                  size="sm"
                  type="button"
                >
                  Read pasted JSON
                </OctantButton>
              </div>
              {importError === undefined ? null : (
                <OctantAlert tone="warning">
                  <p>{importError}</p>
                </OctantAlert>
              )}
            </div>
          ) : null}
          {suites.length === 0 ? (
            <SurfaceEmpty
              detail="A suite is a set of prompts with checks. Run it against several models to see which does best."
              title="No suites yet"
            />
          ) : (
            <div className="usage-table-scroll">
              <table aria-label="Suites" className="usage-table">
                <thead>
                  <tr>
                    <th scope="col">Suite</th>
                    <th scope="col">Cases</th>
                    <th scope="col">Last run</th>
                    <th scope="col">
                      <span className="benchmark-visually-hidden">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {suites.map((suite) => {
                    const last = lastRunOf(suite);
                    return (
                      <tr key={String(suite.suiteId)}>
                        <th scope="row">
                          <OctantButton
                            variant="bare"
                            aria-pressed={String(suite.suiteId) === selectedSuiteId}
                            className="benchmark-link benchmark-link--name"
                            title={suite.name}
                            onClick={() => {
                              setSelectedSuiteId(String(suite.suiteId));
                              setSelectedRunId(undefined);
                            }}
                            type="button"
                          >
                            {suite.name}
                          </OctantButton>
                        </th>
                        <td>{suite.cases.length}</td>
                        <td>
                          {last === undefined
                            ? "Never run"
                            : `${formatWhen(last.startedAt)} · ${RUN_STATUS_WORDS[last.status]}`}
                        </td>
                        <td className="benchmark-actions">
                          <OctantButton
                            aria-label={`Edit ${suite.name}`}
                            onClick={() => {
                              setNotice(undefined);
                              setEditing(suiteToDraft(suite));
                            }}
                            size="icon"
                            type="button"
                            variant="ghost"
                          >
                            <Pencil aria-hidden="true" size={14} />
                          </OctantButton>
                          <OctantButton
                            aria-label={`Export ${suite.name} as JSON`}
                            onClick={() => exportSuite(suite)}
                            size="icon"
                            type="button"
                            variant="ghost"
                          >
                            <Download aria-hidden="true" size={14} />
                          </OctantButton>
                          <OctantButton
                            aria-label={`Delete ${suite.name}`}
                            onClick={() => setPending({ kind: "delete-suite", suite })}
                            size="icon"
                            type="button"
                            variant="ghost"
                          >
                            <Trash2 aria-hidden="true" size={14} />
                          </OctantButton>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </SurfaceSection>
      )}

      {editing !== undefined || selectedSuite === undefined ? null : (
        <>
          <BenchmarkRunBuilder
            models={
              selectedSuite.cases.some((candidate) => candidate.kind === "code")
                ? codeModels
                : models
            }
            names={names}
            onStart={startRun}
            report={report}
            suite={selectedSuite}
          />
          <SurfaceSection label="Runs">
            {suiteRuns.length === 0 ? (
              <p className="usage-workspace__note">This suite has not been run.</p>
            ) : (
              runsTable(suiteRuns, "Runs of this suite")
            )}
          </SurfaceSection>
        </>
      )}

      {editing !== undefined || orphanRuns.length === 0 ? null : (
        <SurfaceSection label="Runs of deleted suites">
          {runsTable(orphanRuns, "Runs of deleted suites")}
        </SurfaceSection>
      )}

      {editing !== undefined || runRead === undefined ? null : (
        <>
          <BenchmarkLiveGrid
            cancelPending={cancelling}
            metricsByCell={metricsByCell}
            names={names}
            onCancel={() => void cancelRun()}
            onSelectCase={setSelectedCaseId}
            run={runRead.run}
            selectedCaseId={selectedCaseId}
          />
          <BenchmarkLeaderboard
            key={String(runRead.run.runId)}
            metricsByCell={metricsByCell}
            names={names}
            onSelectCase={setSelectedCaseId}
            {...(runRead.overhead === undefined ? {} : { overhead: runRead.overhead })}
            rows={runRead.leaderboard}
            run={runRead.run}
          />
          <BenchmarkCaseCompare
            onRate={rateCell}
            {...(props.chatClient === undefined ? {} : { chatClient: props.chatClient })}
            metricsByCell={metricsByCell}
            names={names}
            {...(props.onOpenSubject === undefined ? {} : { onOpenSubject: props.onOpenSubject })}
            onSelectCase={setSelectedCaseId}
            run={runRead.run}
            selectedCaseId={selectedCaseId}
          />
        </>
      )}

      {pending === undefined ? null : (
        <OctantConfirmDialog
          confirmLabel={pending.kind === "delete-suite" ? "Delete suite" : "Purge run"}
          destructive
          onCancel={() => setPending(undefined)}
          onConfirm={() => void confirmPending()}
          pending={working}
          title={pending.kind === "delete-suite" ? "Delete this suite?" : "Purge this run?"}
        >
          {pending.kind === "delete-suite"
            ? `"${pending.suite.name}" is removed. Its finished runs stay until you purge them.`
            : "Purging erases the run's threads and any worktrees it made, and cannot be undone. The run's figures go with them."}
        </OctantConfirmDialog>
      )}
    </>
  );

  return props.embedded === true ? (
    <section
      aria-label="Benchmarks"
      className="usage-workspace turn-diagnostics benchmarks"
      data-embedded="true"
    >
      {body}
    </section>
  ) : (
    <Surface ariaLabel="Benchmarks">
      <div className="usage-workspace turn-diagnostics benchmarks">{body}</div>
    </Surface>
  );
}
