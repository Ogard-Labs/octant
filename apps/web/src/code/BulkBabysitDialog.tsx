import type { CodeClient } from "@octant/client-runtime";
import type {
  CodeProjectPullRequestRow,
  CodeProjectPullRequestSwitchTarget,
  CodeThreadId,
} from "@octant/contracts";
import { useId, useRef, useState } from "react";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantDialog } from "../ui/base/OctantDialog";
import { OctantSelectField } from "../ui/base/OctantSelect";
import { projectPullRequestKey } from "./projectPullRequestKey";
import { switchRefusalCopy } from "./ProjectPullRequestSupport";
import { OctantCheckbox } from "../ui/base/OctantCheckbox";
import {
  OctantField,
  OctantFieldLabel,
  OctantFieldGroup,
  OctantFieldError,
} from "../ui/base/OctantField";
import { OctantInput } from "../ui/base/OctantInput";
export type BabysitClient = Pick<
  CodeClient,
  "queryProjectPullRequestSwitches" | "setProjectPullRequestAutoFix" | "mergeProjectPullRequest"
>;

export function targetFor({
  projectId,
  repositoryOwner,
  repositoryName,
  number,
}: CodeProjectPullRequestRow): CodeProjectPullRequestSwitchTarget {
  return { projectId, repositoryOwner, repositoryName, number };
}

export function invalidBabysitLabel(label: string) {
  return /[,\r\n]/.test(label);
}

export function BabysitRuleFields({
  all,
  label,
  busy,
  setAll,
  setLabel,
}: {
  readonly all: boolean;
  readonly label: string;
  readonly busy: boolean;
  readonly setAll: (value: boolean) => void;
  readonly setLabel: (value: string) => void;
}) {
  const labelId = useId();
  const invalidLabel = invalidBabysitLabel(label);
  return (
    <OctantFieldGroup>
      <OctantFieldLabel>
        <OctantCheckbox
          checked={all}
          disabled={busy}
          onChange={(event) => setAll(event.target.checked)}
        />{" "}
        Require all checks, including optional ones
      </OctantFieldLabel>
      <OctantField>
        <OctantFieldLabel htmlFor={labelId}>Required label (optional)</OctantFieldLabel>
        <OctantInput
          id={labelId}
          aria-invalid={invalidLabel}
          value={label}
          maxLength={50}
          disabled={busy}
          onChange={(event) => setLabel(event.target.value)}
          placeholder="e.g. qa-approved"
        />
        {invalidLabel && <OctantFieldError>Enter one label.</OctantFieldError>}
      </OctantField>
    </OctantFieldGroup>
  );
}

interface StartResult {
  readonly done: boolean;
  readonly text: string;
}

export function BulkBabysitDialog(props: {
  readonly rows: ReadonlyArray<CodeProjectPullRequestRow>;
  readonly client: BabysitClient;
  readonly threadId?: CodeThreadId;
  readonly onClose: () => void;
}) {
  const titleId = useId();
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [owners, setOwners] = useState<Readonly<Record<string, string>>>({});
  const [results, setResults] = useState<Readonly<Record<string, StartResult>>>({});
  const [all, setAll] = useState(false);
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const running = useRef(false);
  function owner(row: CodeProjectPullRequestRow) {
    const choice = props.threadId ?? owners[projectPullRequestKey(row)];
    return (
      row.linkedThreads.find((t) => String(t.threadId) === String(choice))?.threadId ??
      (row.linkedThreads.length === 1 ? row.linkedThreads[0]?.threadId : undefined)
    );
  }
  const pending = props.rows.filter(
    (row) => selected.has(projectPullRequestKey(row)) && !results[projectPullRequestKey(row)]?.done,
  );
  async function start() {
    const write = props.client.setProjectPullRequestAutoFix?.bind(props.client);
    if (
      running.current ||
      !write ||
      invalidBabysitLabel(label) ||
      !pending.length ||
      pending.some((row) => !owner(row))
    )
      return;
    running.current = true;
    setBusy(true);
    try {
      for (const row of pending) {
        const threadId = owner(row);
        if (!threadId) continue;
        const key = projectPullRequestKey(row);
        let result: StartResult;
        try {
          const outcome = await write({
            kind: "enable",
            target: targetFor(row),
            threadId,
            babysit: {
              checks: all ? "all" : "required",
              ...(label.trim() ? { requiredLabel: label.trim() } : {}),
            },
          });
          if (outcome.status === "applied")
            result = { done: true, text: outcome.alreadyActive ? "Already active" : "Started" };
          else if (outcome.status === "refused" && outcome.reason === "already-active")
            result = { done: true, text: "Already active with another owner or rules" };
          else result = { done: false, text: switchRefusalCopy("auto-fix", outcome) };
        } catch {
          result = { done: false, text: "Could not confirm the watch. Retry to check." };
        }
        setResults((previous) => ({ ...previous, [key]: result }));
      }
    } finally {
      running.current = false;
      setBusy(false);
    }
  }
  return (
    <OctantDialog
      open
      label="Babysit multiple pull requests"
      labelledBy={titleId}
      className="octant-confirmation"
      onClose={() => {
        if (!running.current) props.onClose();
      }}
    >
      <h2 className="octant-confirmation__title" id={titleId}>
        Babysit multiple pull requests
      </h2>
      <div className="pr-page__watch-choices">
        {props.rows.map((row) => {
          const key = projectPullRequestKey(row);
          const display = `${row.repositoryOwner}/${row.repositoryName}#${row.number}`;
          const locked = busy || results[key]?.done === true;
          return (
            <div key={key}>
              <OctantFieldLabel>
                <OctantCheckbox
                  checked={selected.has(key)}
                  disabled={locked || row.linkedThreads.length === 0}
                  onChange={(event) => {
                    const next = new Set(selected);
                    if (event.target.checked) next.add(key);
                    else next.delete(key);
                    setSelected(next);
                  }}
                />
                {display} · {row.title}
              </OctantFieldLabel>
              {row.linkedThreads.length === 0 && <small>Link a Code thread first.</small>}
              {selected.has(key) && !props.threadId && row.linkedThreads.length > 1 && (
                <OctantSelectField
                  aria-label={`Repairing thread for ${display}`}
                  disabled={locked}
                  value={owner(row) ?? ""}
                  placeholder="Choose the thread for repairs"
                  options={row.linkedThreads.map((t) => ({ id: t.threadId, label: t.title }))}
                  onValueChange={(value) =>
                    setOwners((previous) => ({ ...previous, [key]: value }))
                  }
                />
              )}
              {results[key] && <span role="status">{results[key].text}</span>}
            </div>
          );
        })}
      </div>
      <BabysitRuleFields all={all} label={label} busy={busy} setAll={setAll} setLabel={setLabel} />
      <div className="octant-dialog__actions">
        <OctantButton type="button" variant="outline" disabled={busy} onClick={props.onClose}>
          Close
        </OctantButton>
        <OctantButton
          type="button"
          disabled={
            busy ||
            !pending.length ||
            pending.some((row) => !owner(row)) ||
            invalidBabysitLabel(label)
          }
          onClick={() => void start()}
        >
          {busy ? "Starting watches…" : `Start selected (${pending.length})`}
        </OctantButton>
      </div>
    </OctantDialog>
  );
}
