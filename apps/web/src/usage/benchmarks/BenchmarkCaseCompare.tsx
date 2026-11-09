import { CircleCheck, CircleX, Star } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  decodeChatThreadId,
  type BenchmarkCase,
  type BenchmarkCell,
  type BenchmarkCellMetrics,
  type BenchmarkRun,
} from "@octant/contracts";
import type { ChatClient } from "@octant/client-runtime";
import { OctantAlert } from "../../ui/base/OctantAlert";
import { OctantButton } from "../../ui/base/OctantButton";
import { OctantInput } from "../../ui/base/OctantInput";
import { moveWithinRadioGroup } from "../../ui/base/radioGroupKeys";
import { OctantSelectField } from "../../ui/base/OctantSelect";
import { SurfaceSection } from "../../surface/SurfaceHeader";
import { turnReplyText } from "../../chat/chatReply";
import { CellState, cellElapsedMs, cellTokens } from "./BenchmarkLiveGrid";
import {
  CHECK_KIND_WORDS,
  contenderLabel,
  formatDuration,
  formatSpeed,
  formatTokens,
  formatUsd,
  type ContenderNames,
} from "./benchmarkPresentation";

type Answer =
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly text: string | undefined }
  | { readonly status: "failure" };

export interface BenchmarkCaseCompareProps {
  readonly run: BenchmarkRun;
  readonly metricsByCell: ReadonlyMap<string, BenchmarkCellMetrics>;
  readonly names: ContenderNames;
  readonly selectedCaseId: string | undefined;
  readonly onSelectCase: (caseId: string) => void;
  /** Reads a Chat thread; without it the answers cannot be shown here. */
  readonly chatClient?: Pick<ChatClient, "thread">;
  readonly onOpenSubject?: (subjectType: string, subjectId: string) => void;
  /** Saves stars for a cell; resolves to the sentence to show when it was refused. */
  readonly onRate?: (
    cellId: string,
    stars: number,
    note: string | undefined,
  ) => Promise<string | undefined>;
}

/**
 * One case with every contender's answer side by side. An answer is read from
 * the cell's own thread, because the run keeps no copy of it, so what is shown
 * here is what the thread says now.
 */
export function BenchmarkCaseCompare(props: BenchmarkCaseCompareProps) {
  const { run } = props;
  const benchmarkCase =
    run.cases.find((candidate) => String(candidate.caseId) === props.selectedCaseId) ??
    run.cases[0];
  const cells = useMemo(
    () =>
      benchmarkCase === undefined
        ? []
        : run.cells.filter((cell) => String(cell.caseId) === String(benchmarkCase.caseId)),
    [run.cells, benchmarkCase],
  );
  const answers = useCellAnswers(benchmarkCase, cells, props.chatClient);
  if (benchmarkCase === undefined) return null;

  return (
    <SurfaceSection label="Case compare">
      <label className="usage-workspace__field benchmark-compare__picker">
        <span>Case</span>
        <OctantSelectField
          aria-label="Case to compare"
          onValueChange={props.onSelectCase}
          options={run.cases.map((candidate) => ({
            id: String(candidate.caseId),
            label: candidate.title,
          }))}
          value={String(benchmarkCase.caseId)}
        />
      </label>
      <div className="benchmark-compare__grid">
        {run.contenders.map((contender, contenderIndex) => (
          <section
            aria-label={`Answers from ${contenderLabel(contender, props.names)}`}
            className="benchmark-compare__column"
            key={contenderIndex}
          >
            <h3 className="usage-workspace__subheading">
              {contenderLabel(contender, props.names)}
            </h3>
            {cells
              .filter((cell) => cell.contenderIndex === contenderIndex)
              .sort((left, right) => left.repetition - right.repetition)
              .map((cell) => (
                <CompareCell
                  answer={answers.get(String(cell.cellId))}
                  benchmarkCase={benchmarkCase}
                  cell={cell}
                  chatAvailable={props.chatClient !== undefined}
                  {...(props.onRate === undefined ? {} : { onRate: props.onRate })}
                  key={String(cell.cellId)}
                  metrics={props.metricsByCell.get(String(cell.cellId))}
                  {...(props.onOpenSubject === undefined
                    ? {}
                    : { onOpenSubject: props.onOpenSubject })}
                  repetitions={run.repetitions}
                />
              ))}
          </section>
        ))}
      </div>
    </SurfaceSection>
  );
}

function CompareCell(props: {
  readonly cell: BenchmarkCell;
  readonly benchmarkCase: BenchmarkCase;
  readonly metrics: BenchmarkCellMetrics | undefined;
  readonly repetitions: number;
  readonly answer: Answer | undefined;
  readonly chatAvailable: boolean;
  readonly onOpenSubject?: (subjectType: string, subjectId: string) => void;
  readonly onRate?: BenchmarkCaseCompareProps["onRate"];
}) {
  const { cell, metrics } = props;
  const subjectType = props.benchmarkCase.kind === "code" ? "code-thread" : "chat-thread";
  return (
    <article className="benchmark-compare__cell">
      <header className="benchmark-compare__cell-head">
        <CellState state={cell.state} />
        {props.repetitions > 1 ? (
          <span className="usage-workspace__note">run {cell.repetition}</span>
        ) : null}
        {cell.threadId === undefined || props.onOpenSubject === undefined ? null : (
          <OctantButton
            onClick={() => props.onOpenSubject?.(subjectType, String(cell.threadId))}
            size="sm"
            type="button"
            variant="ghost"
          >
            Open thread
          </OctantButton>
        )}
      </header>
      {cell.failureReason === undefined ? null : (
        <p className="usage-workspace__note">{cell.failureReason}</p>
      )}
      <Answer
        answer={props.answer}
        chatAvailable={props.chatAvailable}
        code={props.benchmarkCase.kind === "code"}
        state={cell.state}
      />
      <dl className="benchmark-figures">
        <dt>Time</dt>
        <dd>{formatDuration(cellElapsedMs(cell, metrics))}</dd>
        <dt>First token</dt>
        <dd>{formatDuration(metrics?.timeToFirstTokenMs)}</dd>
        <dt>Speed</dt>
        <dd>{formatSpeed(metrics?.tokensPerSecond)}</dd>
        <dt>Tokens</dt>
        <dd>{formatTokens(cellTokens(metrics))}</dd>
        <dt>Cost</dt>
        <dd>{formatUsd(metrics?.costUsd)}</dd>
      </dl>
      {cell.checks.length === 0 ? null : (
        <ul aria-label="Check results" className="benchmark-checks-result">
          {cell.checks.map((result) => {
            const check = props.benchmarkCase.checks[result.index];
            const Icon = result.passed ? CircleCheck : CircleX;
            return (
              <li key={result.index}>
                <Icon aria-hidden="true" size={14} />
                <span>
                  {result.passed ? "Passed" : "Failed"}:{" "}
                  {check === undefined ? "A check" : CHECK_KIND_WORDS[check.kind]}
                  {result.detail === undefined ? "" : `. ${result.detail}`}
                </span>
              </li>
            );
          })}
        </ul>
      )}
      {cell.judge === undefined ? null : cell.judge.status === "scored" ? (
        <p className="benchmark-judge">
          Judge: {cell.judge.score} of 10. {cell.judge.reason}
        </p>
      ) : (
        <p className="benchmark-judge">Judge did not score. {cell.judge.reason}</p>
      )}
      {cell.rating === undefined ? null : (
        <p className="benchmark-judge">
          Rated {cell.rating.stars} of 5.
          {cell.rating.note === undefined ? "" : ` ${cell.rating.note}`}
        </p>
      )}
      {cell.state !== "answered" || props.onRate === undefined ? null : (
        <StarControl cell={cell} onRate={props.onRate} />
      )}
    </article>
  );
}

function Answer(props: {
  readonly answer: Answer | undefined;
  readonly chatAvailable: boolean;
  readonly code: boolean;
  readonly state: BenchmarkCell["state"];
}) {
  if (props.state !== "answered") return null;
  if (props.code) {
    return (
      <p className="usage-workspace__note">
        This is a Code case. Open its thread to read the work it did.
      </p>
    );
  }
  if (!props.chatAvailable) {
    return <p className="usage-workspace__note">Answers cannot be read in this window.</p>;
  }
  if (props.answer === undefined || props.answer.status === "loading") {
    return <p className="usage-workspace__note">Loading the answer…</p>;
  }
  if (props.answer.status === "failure") {
    return <p className="usage-workspace__note">The thread could not be read. It may be purged.</p>;
  }
  return props.answer.text === undefined ? (
    <p className="usage-workspace__note">The thread holds no answer.</p>
  ) : (
    <pre aria-label="Answer" className="benchmark-answer">
      {props.answer.text}
    </pre>
  );
}

/**
 * Reads each answered prompt cell's reply from its thread. A cell is read once;
 * a run read that only moves other cells does not ask the thread again.
 */
function useCellAnswers(
  benchmarkCase: BenchmarkCase | undefined,
  cells: ReadonlyArray<BenchmarkCell>,
  chatClient: BenchmarkCaseCompareProps["chatClient"],
): ReadonlyMap<string, Answer> {
  const [answers, setAnswers] = useState<ReadonlyMap<string, Answer>>(new Map());
  const wanted = useMemo(
    () =>
      benchmarkCase?.kind !== "prompt"
        ? []
        : cells.filter(
            (cell) =>
              cell.state === "answered" && cell.threadId !== undefined && cell.turnId !== undefined,
          ),
    [benchmarkCase, cells],
  );
  const wantedKey = wanted.map((cell) => String(cell.cellId)).join(",");
  const requested = useRef(new Set<string>());
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    if (chatClient === undefined) return;
    for (const cell of wanted) {
      const id = String(cell.cellId);
      if (requested.current.has(id)) continue;
      requested.current.add(id);
      setAnswers((previous) => new Map(previous).set(id, { status: "loading" }));
      Promise.resolve()
        .then(() => chatClient.thread(decodeChatThreadId(String(cell.threadId))))
        .then(
          (view): Answer => ({ status: "ready", text: turnReplyText(view, String(cell.turnId)) }),
          (): Answer => ({ status: "failure" }),
        )
        .then((answer) => {
          if (mounted.current) setAnswers((previous) => new Map(previous).set(id, answer));
        });
    }
    // The set of cells to read is the only input; `wanted` follows it.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [chatClient, wantedKey]);
  return answers;
}

/**
 * Your stars for one answer, with an optional note. The radios are native, so
 * the arrow keys move between them, and each is named "3 of 5 stars". Saving
 * again replaces the earlier rating.
 */
function StarControl(props: {
  readonly cell: BenchmarkCell;
  readonly onRate: NonNullable<BenchmarkCaseCompareProps["onRate"]>;
}) {
  const id = String(props.cell.cellId);
  const [stars, setStars] = useState<number | undefined>(props.cell.rating?.stars);
  const [note, setNote] = useState(props.cell.rating?.note ?? "");
  const [message, setMessage] = useState<string | undefined>(undefined);
  const [pending, setPending] = useState(false);
  // A newer rating from a refreshed run replaces what the control holds.
  const savedStars = props.cell.rating?.stars;
  const savedNote = props.cell.rating?.note;
  useEffect(() => {
    setStars(savedStars);
    setNote(savedNote ?? "");
  }, [savedStars, savedNote]);

  const save = async () => {
    if (stars === undefined) return;
    setPending(true);
    setMessage(undefined);
    const refusal = await props.onRate(id, stars, note.trim() === "" ? undefined : note.trim());
    setPending(false);
    if (refusal !== undefined) setMessage(refusal);
  };

  return (
    <div className="benchmark-stars">
      <div
        aria-label="Your rating"
        className="benchmark-stars__group"
        onKeyDown={moveWithinRadioGroup}
        role="radiogroup"
      >
        {[1, 2, 3, 4, 5].map((value) => (
          <OctantButton
            aria-checked={stars === value}
            aria-label={`${value} of 5 stars`}
            className="benchmark-stars__star"
            key={value}
            onClick={() => setStars(value)}
            role="radio"
            size="icon-sm"
            tabIndex={stars === value || (stars === undefined && value === 1) ? 0 : -1}
            type="button"
            variant="ghost"
          >
            <Star
              aria-hidden="true"
              fill={stars !== undefined && value <= stars ? "currentColor" : "none"}
              size={16}
            />
          </OctantButton>
        ))}
      </div>
      <OctantInput
        aria-label="Note on this answer"
        maxLength={512}
        onChange={(event) => setNote(event.currentTarget.value)}
        placeholder="Optional note"
        value={note}
      />
      <OctantButton
        disabled={stars === undefined || pending}
        onClick={() => void save()}
        size="sm"
        type="button"
        variant="outline"
      >
        {props.cell.rating === undefined ? "Save rating" : "Replace rating"}
      </OctantButton>
      {message === undefined ? null : (
        <OctantAlert tone="warning">
          <p>{message}</p>
        </OctantAlert>
      )}
    </div>
  );
}
