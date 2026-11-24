import type { CodeClient } from "@octant/client-runtime";
import type {
  CodeProjectPullRequestAutoFixState,
  CodeProjectPullRequestRow,
  CodeProjectPullRequestSwitchTarget,
  CodeThreadId,
  ProjectId,
} from "@octant/contracts";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { scheduleVisibleInterval } from "../polling/documentVisibility";
import { projectPullRequestKey } from "./projectPullRequestKey";
import { OctantAlert } from "../ui/base/OctantAlert";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantDialog } from "../ui/base/OctantDialog";
import { OctantSelectField } from "../ui/base/OctantSelect";
import {
  autoFixCopy,
  pullRequestControlsLoadMessage,
  switchRefusalCopy,
} from "./ProjectPullRequestSupport";

import {
  BulkBabysitDialog,
  BabysitRuleFields,
  invalidBabysitLabel,
  targetFor,
  type BabysitClient,
} from "./BulkBabysitDialog";
export type { BabysitClient } from "./BulkBabysitDialog";

interface WatchChoice {
  readonly id: string;
  readonly label: string;
  readonly target: CodeProjectPullRequestSwitchTarget;
  readonly threadId: CodeThreadId;
}

export function PullRequestBabysitDialog(props: {
  readonly client: CodeClient;
  readonly projectId: ProjectId;
  readonly threadId: CodeThreadId;
  readonly onClose: () => void;
}) {
  const [rows, setRows] = useState<ReadonlyArray<CodeProjectPullRequestRow>>();
  const [bulk, setBulk] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    let live = true;
    void props.client
      .queryProjectPullRequests({ version: 1, threadId: props.threadId })
      .then((view) => {
        if (!live) return;
        setRows(
          view.rows.filter(
            (row) =>
              String(row.projectId) === String(props.projectId) &&
              row.linkedThreads.some(
                (thread) => String(thread.threadId) === String(props.threadId),
              ) &&
              row.state !== "merged" &&
              row.state !== "closed",
          ),
        );
      })
      .catch((error: unknown) => {
        if (live)
          setError(
            pullRequestControlsLoadMessage(error) ??
              "Octant could not read this thread’s pull requests.",
          );
      });
    return () => {
      live = false;
    };
  }, [props.client, props.projectId, props.threadId]);
  const choices = useMemo(
    () =>
      rows?.map((row) => ({
        id: projectPullRequestKey(row),
        label: `${row.repositoryOwner}/${row.repositoryName}#${row.number} · ${row.title}`,
        target: targetFor(row),
        threadId: props.threadId,
      })),
    [rows, props.threadId],
  );
  if (bulk && rows)
    return (
      <BulkBabysitDialog
        rows={rows}
        client={props.client}
        threadId={props.threadId}
        onClose={props.onClose}
      />
    );
  return (
    <WatchChoiceDialog
      client={props.client}
      choices={choices}
      {...(choices && choices.length > 1 ? { onBulk: () => setBulk(true) } : {})}
      error={error}
      onClose={props.onClose}
      title="Babysit a pull request"
      field="Linked pull request"
      placeholder="Choose a linked pull request"
      empty="Link an open pull request to this Code thread to start babysitting."
    />
  );
}

export function OverviewBabysitDialog(props: {
  readonly client: BabysitClient;
  readonly row: CodeProjectPullRequestRow;
  readonly onClose: () => void;
}) {
  const { row } = props;
  const choices = useMemo(
    () =>
      row.linkedThreads.map((thread) => ({
        id: String(thread.threadId),
        label: thread.title,
        threadId: thread.threadId,
        target: targetFor(row),
      })),
    [row],
  );
  return (
    <WatchChoiceDialog
      client={props.client}
      choices={choices}
      onClose={props.onClose}
      {...(row.babysit ? { initialChoice: String(row.babysit.threadId) } : {})}
      title={`Babysit ${row.repositoryOwner}/${row.repositoryName}#${row.number}`}
      field="Repairing Code thread"
      placeholder="Choose the thread for repairs"
      empty="Link a Code thread to this pull request to start babysitting."
    />
  );
}

function WatchChoiceDialog(props: {
  readonly client: BabysitClient;
  readonly choices: ReadonlyArray<WatchChoice> | undefined;
  readonly error?: string;
  readonly onClose: () => void;
  readonly title: string;
  readonly onBulk?: () => void;
  readonly initialChoice?: string;
  readonly field: string;
  readonly placeholder: string;
  readonly empty: string;
}) {
  const titleId = useId();
  const title = useRef<HTMLHeadingElement>(null);
  const [selected, setSelected] = useState(props.initialChoice ?? "");
  const choice =
    props.choices?.length === 1
      ? props.choices[0]
      : props.choices?.find((item) => item.id === selected);
  return (
    <OctantDialog
      initialFocus={title}
      open
      label={props.title}
      labelledBy={titleId}
      className="octant-confirmation"
      onClose={props.onClose}
    >
      <h2 ref={title} tabIndex={-1} className="octant-confirmation__title" id={titleId}>
        {props.title}
      </h2>
      {props.error ? (
        <OctantAlert tone="warning">{props.error}</OctantAlert>
      ) : !props.choices ? (
        <p role="status">Loading linked pull requests…</p>
      ) : props.choices.length === 0 ? (
        <p>{props.empty}</p>
      ) : (
        <OctantSelectField
          aria-label={props.field}
          value={choice?.id ?? ""}
          placeholder={props.placeholder}
          onValueChange={setSelected}
          options={props.choices}
        />
      )}
      {props.onBulk && (
        <OctantButton type="button" variant="outline" onClick={props.onBulk}>
          Babysit multiple…
        </OctantButton>
      )}
      {choice ? (
        <BabysitControls
          key={choice.id}
          target={choice.target}
          threadId={choice.threadId}
          client={props.client}
          onClose={props.onClose}
        />
      ) : (
        <div className="octant-dialog__actions">
          <OctantButton type="button" variant="outline" onClick={props.onClose}>
            Close
          </OctantButton>
        </div>
      )}
    </OctantDialog>
  );
}

function BabysitControls(props: {
  readonly onClose: () => void;
  readonly target: CodeProjectPullRequestSwitchTarget;
  readonly threadId: CodeThreadId;
  readonly client: BabysitClient;
}) {
  const [state, setState] = useState<CodeProjectPullRequestAutoFixState>();
  const [all, setAll] = useState(false);
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const seededStop = useRef<string | undefined>(undefined);
  const revision = useRef(0);
  const writing = useRef(false);
  const [readError, setReadError] = useState("");
  useEffect(() => {
    let live = true;
    const read = () => {
      if (writing.current) return;
      const pendingRead = ++revision.current;
      void props.client
        .queryProjectPullRequestSwitches?.(props.target)
        .then((view) => {
          if (live && revision.current === pendingRead) {
            const watch = view.autoFix;
            if (
              watch.status === "stopped" &&
              String(watch.threadId) === String(props.threadId) &&
              watch.babysit &&
              seededStop.current !== watch.stoppedAt
            ) {
              setAll(watch.babysit.checks === "all");
              setLabel(watch.babysit.requiredLabel ?? "");
              seededStop.current = watch.stoppedAt;
            }
            setState(watch);
            setReadError("");
          }
        })
        .catch((error: unknown) => {
          if (live && revision.current === pendingRead)
            setReadError(
              pullRequestControlsLoadMessage(error) ??
                "Octant could not read the current Auto-fix settings.",
            );
        });
    };
    read();
    const cancel = scheduleVisibleInterval(read, 20_000);
    return () => {
      live = false;
      cancel();
    };
  }, [props.client, props.target, props.threadId]);

  const invalidLabel = invalidBabysitLabel(label);
  const active = state?.status === "on";
  const saved =
    state?.status === "stopped" &&
    String(state.threadId) === String(props.threadId) &&
    state.babysit;
  const anotherThread = active && String(state.threadId) !== String(props.threadId);
  async function change() {
    if (writing.current || !state || anotherThread || !props.client.setProjectPullRequestAutoFix)
      return;
    writing.current = true;
    revision.current++;
    setBusy(true);
    setError("");
    try {
      const requiredLabel = label.trim();
      const outcome = await props.client.setProjectPullRequestAutoFix(
        active
          ? { kind: "disable", target: props.target, threadId: props.threadId }
          : {
              kind: "enable",
              ...(saved && { expectedStoppedAt: state.stoppedAt }),
              target: props.target,
              threadId: props.threadId,
              babysit: {
                checks: all ? "all" : "required",
                ...(requiredLabel ? { requiredLabel } : {}),
              },
            },
      );
      if (outcome.status === "applied") setState(outcome.view.autoFix);
      else setError(switchRefusalCopy("auto-fix", outcome));
    } catch (error) {
      setError(
        pullRequestControlsLoadMessage(error) ??
          "Octant could not update this pull request. Reopen the command to check its status.",
      );
    } finally {
      writing.current = false;
      setBusy(false);
    }
  }
  return (
    <>
      {!state && !readError && <p role="status">Reading watch settings…</p>}
      {state?.status === "stopped" && <p role="status">{autoFixCopy(state, undefined)}</p>}
      {active ? (
        <p role="status">
          {anotherThread
            ? "Another linked thread is fixing this pull request."
            : autoFixCopy(state, undefined)}
        </p>
      ) : (
        state && (
          <>
            <p className="octant-confirmation__description">
              This thread fixes failing checks, reviews open findings, and updates the branch when
              needed. It stops when the PR can merge and its review threads are clear.
            </p>
            <BabysitRuleFields
              all={all}
              label={label}
              busy={busy}
              setAll={setAll}
              setLabel={setLabel}
            />
          </>
        )
      )}
      {readError && <OctantAlert tone="warning">{readError}</OctantAlert>}
      {error && <OctantAlert tone="warning">{error}</OctantAlert>}
      <div className="octant-dialog__actions">
        <OctantButton type="button" variant="outline" onClick={props.onClose}>
          Close
        </OctantButton>
        {state && !anotherThread && (
          <OctantButton
            type="button"
            disabled={busy || (!active && invalidLabel)}
            onClick={() => void change()}
          >
            {active
              ? state.babysit
                ? "Stop babysitting"
                : "Stop Auto-fix"
              : saved
                ? "Resume babysitting"
                : "Start babysitting"}
          </OctantButton>
        )}
      </div>
    </>
  );
}
