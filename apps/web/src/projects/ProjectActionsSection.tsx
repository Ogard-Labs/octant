import type { ProjectTerminalClient } from "@octant/client-runtime/project-terminal-client";
import type { ProjectActionSuggestion } from "@octant/contracts/project-terminals";
import {
  MAX_PROJECT_ACTIONS,
  decodeProjectActions,
  type ProjectAction,
  type ProjectSummary,
} from "@octant/contracts/projects";
import { Plus, X } from "lucide-react";
import { useEffect, useState } from "react";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantFieldError } from "../ui/base/OctantField";
import { OctantInput } from "../ui/base/OctantInput";

type CodeProjectSummary = Extract<ProjectSummary, { readonly type: "code" }>;

export interface ProjectActionsSectionProps {
  readonly project: CodeProjectSummary;
  /** Asks the host what the Project's files suggest; absent when this window has no route to it. */
  readonly client?: Pick<ProjectTerminalClient, "execute">;
  readonly onChange: (actions: ReadonlyArray<ProjectAction>) => Promise<boolean>;
  readonly disabled?: boolean;
}

interface Row {
  readonly id: string;
  readonly name: string;
  readonly command: string;
  readonly directory: string;
}

type Suggestions =
  | { readonly status: "loading" }
  | { readonly status: "failed" }
  | { readonly status: "loaded"; readonly suggestions: ReadonlyArray<ProjectActionSuggestion> };

const rowsOf = (actions: ReadonlyArray<ProjectAction> | undefined): ReadonlyArray<Row> =>
  (actions ?? []).map((action) => ({ ...action, id: String(action.id) }));

/** The list a draft saves, or why it cannot be saved yet. */
function actionsOf(rows: ReadonlyArray<Row>): ReadonlyArray<ProjectAction> | undefined {
  try {
    return decodeProjectActions(
      rows.map((row) => ({
        id: row.id,
        name: row.name,
        command: row.command,
        directory: row.directory.trim() === "" ? "." : row.directory.trim(),
      })),
    );
  } catch {
    return undefined;
  }
}

/**
 * A Code Project's named terminal actions: a command and the folder it runs in,
 * shown as buttons in the Project header and the command palette. The person
 * writes each one or confirms a suggestion from the Project's own files; the
 * host decides whether the list may be saved and what running one may do.
 */
export function ProjectActionsSection(props: ProjectActionsSectionProps) {
  const saved = props.project.actions;
  const [rows, setRows] = useState<ReadonlyArray<Row>>(() => rowsOf(saved));
  // When another window saves a list, the draft follows it; otherwise a save
  // would send a stale draft under the refreshed version.
  const filledKey = JSON.stringify(saved ?? null);
  const [filledFrom, setFilledFrom] = useState(filledKey);
  if (filledFrom !== filledKey) {
    setFilledFrom(filledKey);
    setRows(rowsOf(saved));
  }
  const [pending, setPending] = useState(false);
  const [suggested, setSuggested] = useState<Suggestions>({ status: "loading" });
  const { client } = props;
  const projectId = props.project.id;
  useEffect(() => {
    if (client === undefined) {
      setSuggested({ status: "failed" });
      return undefined;
    }
    const controller = new AbortController();
    setSuggested({ status: "loading" });
    client.execute({ kind: "suggest-actions", projectId }, controller.signal).then(
      (answer) => {
        if (controller.signal.aborted) return;
        setSuggested(
          answer.kind === "project-action-suggestions"
            ? { status: "loaded", suggestions: answer.suggestions }
            : { status: "failed" },
        );
      },
      () => {
        if (!controller.signal.aborted) setSuggested({ status: "failed" });
      },
    );
    return () => controller.abort();
  }, [client, projectId]);

  const disabled = props.disabled === true || pending;
  const draft = actionsOf(rows);
  const changed = JSON.stringify(draft ?? rows) !== JSON.stringify(saved ?? []);
  const offered =
    suggested.status === "loaded"
      ? suggested.suggestions.filter(
          (suggestion) => !rows.some((row) => row.command === suggestion.command),
        )
      : [];

  const update = (id: string, patch: Partial<Row>) =>
    setRows((current) => current.map((row) => (row.id === id ? { ...row, ...patch } : row)));
  const add = (row: Omit<Row, "id">) =>
    setRows((current) => [...current, { id: crypto.randomUUID(), ...row }]);

  async function save() {
    if (draft === undefined) return;
    setPending(true);
    try {
      await props.onChange(draft);
    } finally {
      setPending(false);
    }
  }

  const headingId = `project-actions-${props.project.id}`;
  return (
    <section aria-labelledby={headingId} className="project-provider-policy project-actions">
      <div className="project-provider-policy__header">
        <div>
          <h2 id={headingId}>Actions</h2>
          <p>
            Named commands such as Run, Test, or Dev. Each appears as a button in this Project's
            header and in the command palette, and types its command into the Project terminal,
            under the same sandbox and approvals as anything else you type there.
          </p>
        </div>
      </div>
      {rows.map((row) => (
        <div className="project-actions__row" key={row.id}>
          <OctantInput
            aria-label="Action name"
            disabled={disabled}
            maxLength={40}
            onChange={(event) => update(row.id, { name: event.target.value })}
            placeholder="Name"
            value={row.name}
          />
          <OctantInput
            aria-label="Action command"
            disabled={disabled}
            maxLength={1_000}
            onChange={(event) => update(row.id, { command: event.target.value })}
            placeholder="Command"
            value={row.command}
          />
          <OctantInput
            aria-label="Action folder"
            disabled={disabled}
            onChange={(event) => update(row.id, { directory: event.target.value })}
            placeholder="Folder (project root)"
            value={row.directory === "." ? "" : row.directory}
          />
          <OctantButton
            aria-label={`Remove ${row.name === "" ? "action" : row.name}`}
            disabled={disabled}
            onClick={() => setRows((current) => current.filter((other) => other.id !== row.id))}
            size="icon-sm"
            type="button"
            variant="ghost"
          >
            <X aria-hidden="true" size={14} />
          </OctantButton>
        </div>
      ))}
      {changed && draft === undefined ? (
        <OctantFieldError>
          Each action needs a unique name and a one-line command, and a folder inside the Project.
        </OctantFieldError>
      ) : null}
      {offered.length === 0 ? (
        suggested.status === "loading" ? (
          <p className="project-provider-policy__hint" role="status">
            Looking for commands in this Project's files…
          </p>
        ) : null
      ) : (
        <div className="project-actions__suggestions" role="group" aria-label="Suggested actions">
          <p className="project-provider-policy__hint">
            Found in this Project's files. Add the ones you want.
          </p>
          {offered.map((suggestion) => (
            <OctantButton
              disabled={disabled || rows.length >= MAX_PROJECT_ACTIONS}
              key={`${suggestion.source}:${suggestion.command}`}
              onClick={() =>
                add({
                  name: suggestion.name,
                  command: suggestion.command,
                  directory: suggestion.directory,
                })
              }
              size="sm"
              type="button"
              variant="ghost"
            >
              <Plus aria-hidden="true" size={14} />
              {suggestion.name}
              <span className="project-actions__source">
                {suggestion.command} · {suggestion.source}
              </span>
            </OctantButton>
          ))}
        </div>
      )}
      <div>
        <OctantButton
          disabled={disabled || rows.length >= MAX_PROJECT_ACTIONS}
          onClick={() => add({ name: "", command: "", directory: "." })}
          size="sm"
          type="button"
          variant="ghost"
        >
          Add action
        </OctantButton>
        <OctantButton
          disabled={disabled || !changed || draft === undefined}
          onClick={() => void save()}
          size="sm"
          type="button"
        >
          Save actions
        </OctantButton>
      </div>
    </section>
  );
}
