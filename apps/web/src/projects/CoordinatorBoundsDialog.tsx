import {
  decodeCoordinatorDoneWhen,
  MAX_COORDINATOR_DONE_WHEN_ITEMS,
  type CodeThreadId,
  type CoordinatorBounds,
  type CoordinatorDoneWhen,
  type CoordinatorDoneWhenItem,
  type CoordinatorWorkerLevel,
} from "@octant/contracts";
import { coordinatorDoneWhenItemKey } from "@octant/domain";
import { useRef, useState } from "react";
import { OctantAlert } from "../ui/base/OctantAlert";
import { OctantButton, OctantIconButton } from "../ui/base/OctantButton";
import { OctantDialog } from "../ui/base/OctantDialog";
import { OctantInput } from "../ui/base/OctantInput";
import { OctantNumberStepper } from "../ui/base/OctantNumberStepper";
import { OctantSelectField } from "../ui/base/OctantSelect";
import { X } from "../ui/icons";
import { COORDINATOR_BOUND_FIELDS, COORDINATOR_WORKER_LEVELS } from "./coordinatorChoices";
import "./coordinator-bounds-dialog.css";

/** The worker level choice, offered only while the coordinator is being created. */
export interface CoordinatorWorkerLevelChoice {
  readonly level: CoordinatorWorkerLevel | undefined;
}

/** Host-checked done-when condition editor, shown on a running coordinator beside its bounds. */
export interface CoordinatorDoneWhenEditor {
  readonly value: CoordinatorDoneWhen | undefined;
  readonly threads: ReadonlyArray<{ readonly id: CodeThreadId; readonly title: string }>;
  readonly defaultRepository?: string | undefined;
  readonly onSave: (bounds: CoordinatorBounds, doneWhen: CoordinatorDoneWhen | undefined) => void;
}

type DoneWhenKind = CoordinatorDoneWhenItem["kind"];

const DONE_WHEN_KINDS: ReadonlyArray<{ readonly id: DoneWhenKind; readonly label: string }> = [
  { id: "pull-request-merged", label: "Pull request merged" },
  { id: "pull-request-checks-green", label: "Required checks green" },
  { id: "thread-done", label: "Thread Done" },
];

function formatDoneWhenItem(
  item: CoordinatorDoneWhenItem,
  threads: ReadonlyArray<{ readonly id: CodeThreadId; readonly title: string }>,
): string {
  if (item.kind === "thread-done") {
    const match = threads.find((thread) => String(thread.id) === String(item.threadId));
    const label = match === undefined ? String(item.threadId) : match.title;
    return `Thread ${label} is Done`;
  }
  const ref = `${item.repositoryOwner}/${item.repositoryName}#${String(item.number)}`;
  return item.kind === "pull-request-merged"
    ? `Pull request ${ref} is merged`
    : `Pull request ${ref} required checks are green`;
}

/**
 * A coordinator's limits: how often it and its workers may be woken in an
 * hour, how many rounds they may answer each other, and how many workers it
 * may start in an hour (docs/design/coordinator-threads.md § Bounds), plus
 * its optional host-checked "done when" condition when editing a running
 * coordinator. Saving hands back all three bounds; a bound left at its default
 * is not sent, so it keeps following the default.
 *
 * The New coordinator draft opens the same dialog with `workerLevel`, since
 * the host takes the workers' level only on the command that makes the thread
 * a coordinator; a running coordinator's dialog never offers it.
 */
export function CoordinatorBoundsDialog(props: {
  readonly title: string;
  readonly bounds: CoordinatorBounds | undefined;
  readonly workerLevel?: CoordinatorWorkerLevelChoice;
  readonly doneWhen?: CoordinatorDoneWhenEditor;
  readonly onSave: (bounds: CoordinatorBounds, workerLevel?: CoordinatorWorkerLevelChoice) => void;
  readonly onClose: () => void;
}) {
  const [values, setValues] = useState<CoordinatorBounds>(props.bounds ?? {});
  const [level, setLevel] = useState(props.workerLevel?.level);
  const [doneWhenItems, setDoneWhenItems] = useState<ReadonlyArray<CoordinatorDoneWhenItem>>(
    () => props.doneWhen?.value?.items ?? [],
  );
  const [kind, setKind] = useState<DoneWhenKind>("pull-request-merged");
  const [repository, setRepository] = useState(props.doneWhen?.defaultRepository ?? "");
  const [prNumber, setPrNumber] = useState("");
  const [selectedThreadId, setSelectedThreadId] = useState<string>(
    () => props.doneWhen?.threads[0]?.id ?? "",
  );
  const [doneWhenError, setDoneWhenError] = useState<string>();
  const cancel = useRef<HTMLButtonElement>(null);
  const label = props.workerLevel === undefined ? "Coordinator limits" : "Coordinator settings";
  const doneWhen = props.doneWhen;

  const addItem = () => {
    setDoneWhenError(undefined);
    if (doneWhenItems.length >= MAX_COORDINATOR_DONE_WHEN_ITEMS) {
      setDoneWhenError(
        `A coordinator can track at most ${String(MAX_COORDINATOR_DONE_WHEN_ITEMS)} conditions.`,
      );
      return;
    }
    let candidate: unknown;
    if (kind === "thread-done") {
      if (selectedThreadId === "") {
        setDoneWhenError("Choose a thread in this Project.");
        return;
      }
      candidate = { kind: "thread-done", threadId: selectedThreadId };
    } else {
      const parts = repository.trim().split("/");
      const owner = parts[0]?.trim() ?? "";
      const name = parts[1]?.trim() ?? "";
      const parsedNumber = Number.parseInt(prNumber.trim(), 10);
      if (
        parts.length !== 2 ||
        owner === "" ||
        name === "" ||
        !Number.isInteger(parsedNumber) ||
        parsedNumber <= 0 ||
        String(parsedNumber) !== prNumber.trim()
      ) {
        setDoneWhenError("Enter a repository as owner/name and a positive pull request number.");
        return;
      }
      candidate = {
        kind,
        repositoryOwner: owner,
        repositoryName: name,
        number: parsedNumber,
      };
    }
    let decoded: CoordinatorDoneWhen;
    try {
      decoded = decodeCoordinatorDoneWhen({ items: [...doneWhenItems, candidate] });
    } catch {
      setDoneWhenError("That condition is invalid or already in the list.");
      return;
    }
    setDoneWhenItems(decoded.items);
    if (kind !== "thread-done") setPrNumber("");
  };

  const removeItem = (itemKey: string) => {
    setDoneWhenError(undefined);
    setDoneWhenItems((current) =>
      current.filter((item) => coordinatorDoneWhenItemKey(item) !== itemKey),
    );
  };

  const save = () => {
    const chosen: { -readonly [Bound in keyof CoordinatorBounds]: number } = {};
    for (const field of COORDINATOR_BOUND_FIELDS) {
      const value = values[field.bound];
      if (value !== undefined && value !== field.default) chosen[field.bound] = value;
    }
    if (doneWhen !== undefined) {
      doneWhen.onSave(chosen, doneWhenItems.length === 0 ? undefined : { items: doneWhenItems });
      return;
    }
    if (props.workerLevel === undefined) props.onSave(chosen);
    else props.onSave(chosen, { level });
  };
  return (
    <OctantDialog
      className="coordinator-bounds-dialog"
      describedBy="coordinator-bounds-dialog-detail"
      initialFocus={cancel}
      label={label}
      labelledBy="coordinator-bounds-dialog-title"
      onClose={props.onClose}
      open
    >
      <h2 className="coordinator-bounds-dialog__title" id="coordinator-bounds-dialog-title">
        {label}
      </h2>
      <p className="oct-row-detail" id="coordinator-bounds-dialog-detail">
        {props.workerLevel === undefined
          ? `${props.title}: how often this coordinator and its workers wake for each other, and how many workers it starts. Changes apply from the next wake or start.`
          : "What its workers may do, and how often they wake each other."}
      </p>
      {props.workerLevel === undefined ? null : (
        <div className="coordinator-bounds-dialog__row coordinator-bounds-dialog__row--level">
          <span>Workers start at</span>
          <OctantSelectField
            aria-label="Workers start at"
            className="coordinator-bounds-dialog__level"
            onValueChange={(value) =>
              setLevel(COORDINATOR_WORKER_LEVELS.find((entry) => entry.id === value)?.level)
            }
            options={COORDINATOR_WORKER_LEVELS.map((entry) => ({
              id: entry.id,
              label: entry.menuLabel,
            }))}
            value={level ?? ""}
          />
        </div>
      )}
      {COORDINATOR_BOUND_FIELDS.map((field) => (
        <div className="coordinator-bounds-dialog__row" key={field.bound}>
          <span>
            {field.label}
            <span className="oct-meta"> · default {String(field.default)}</span>
            <span className="oct-row-detail coordinator-bounds-dialog__detail">{field.detail}</span>
          </span>
          <OctantNumberStepper
            label={field.label}
            max={field.max}
            min={1}
            onChange={(value) => setValues((current) => ({ ...current, [field.bound]: value }))}
            value={values[field.bound] ?? field.default}
          />
        </div>
      ))}
      {doneWhen === undefined ? null : (
        <section
          aria-labelledby="coordinator-done-when-heading"
          className="coordinator-bounds-dialog__done-when"
        >
          <div className="coordinator-bounds-dialog__done-when-header">
            <div>
              <h3
                className="coordinator-bounds-dialog__section-title"
                id="coordinator-done-when-heading"
              >
                Done when
              </h3>
              <p className="oct-row-detail">
                Octant checks these conditions on a schedule and wakes this coordinator with only
                what is still unmet until all hold.
              </p>
            </div>
            {doneWhenItems.length === 0 ? null : (
              <OctantButton
                onClick={() => {
                  setDoneWhenError(undefined);
                  setDoneWhenItems([]);
                }}
                size="sm"
                type="button"
                variant="ghost"
              >
                Clear all
              </OctantButton>
            )}
          </div>
          {doneWhenItems.length === 0 ? (
            <p className="oct-meta coordinator-bounds-dialog__done-when-empty">
              No done-when condition set.
            </p>
          ) : (
            <ul className="coordinator-bounds-dialog__done-when-list">
              {doneWhenItems.map((item) => {
                const key = coordinatorDoneWhenItemKey(item);
                const text = formatDoneWhenItem(item, doneWhen.threads);
                return (
                  <li className="coordinator-bounds-dialog__done-when-item" key={key}>
                    <span>{text}</span>
                    <OctantIconButton
                      label={`Remove ${text}`}
                      onClick={() => removeItem(key)}
                      size="sm"
                      type="button"
                      variant="ghost"
                    >
                      <X aria-hidden="true" size={14} />
                    </OctantIconButton>
                  </li>
                );
              })}
            </ul>
          )}
          <div className="coordinator-bounds-dialog__done-when-builder">
            <OctantSelectField
              aria-label="Done-when condition kind"
              onValueChange={(value) => {
                setDoneWhenError(undefined);
                const next = DONE_WHEN_KINDS.find((entry) => entry.id === value)?.id;
                if (next !== undefined) setKind(next);
              }}
              options={DONE_WHEN_KINDS}
              value={kind}
            />
            {kind === "thread-done" ? (
              doneWhen.threads.length === 0 ? (
                <p className="oct-row-detail">No other active threads in this Project yet.</p>
              ) : (
                <OctantSelectField
                  aria-label="Done-when thread"
                  onValueChange={(value) => {
                    setDoneWhenError(undefined);
                    setSelectedThreadId(value);
                  }}
                  options={doneWhen.threads.map((thread) => ({
                    id: String(thread.id),
                    label: thread.title,
                  }))}
                  value={selectedThreadId}
                />
              )
            ) : (
              <div className="coordinator-bounds-dialog__done-when-pr-inputs">
                <OctantInput
                  aria-label="Pull request repository"
                  onChange={(event) => {
                    setDoneWhenError(undefined);
                    setRepository(event.target.value);
                  }}
                  placeholder="owner/name"
                  value={repository}
                />
                <OctantInput
                  aria-label="Pull request number"
                  inputMode="numeric"
                  onChange={(event) => {
                    setDoneWhenError(undefined);
                    setPrNumber(event.target.value);
                  }}
                  placeholder="#42"
                  value={prNumber}
                />
              </div>
            )}
            <OctantButton
              disabled={
                doneWhenItems.length >= MAX_COORDINATOR_DONE_WHEN_ITEMS ||
                (kind === "thread-done" && doneWhen.threads.length === 0)
              }
              onClick={addItem}
              size="sm"
              type="button"
              variant="outline"
            >
              Add condition
            </OctantButton>
          </div>
          {doneWhenError === undefined ? null : (
            <OctantAlert layout="row" tone="danger">
              {doneWhenError}
            </OctantAlert>
          )}
        </section>
      )}
      <footer className="coordinator-bounds-dialog__actions">
        <OctantButton onClick={props.onClose} ref={cancel} type="button" variant="outline">
          Cancel
        </OctantButton>
        <OctantButton onClick={save} type="button">
          Save
        </OctantButton>
      </footer>
    </OctantDialog>
  );
}
