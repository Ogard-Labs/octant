import type { ScaffoldEntry, ScaffoldRun } from "@octant/contracts/scaffolds";
import { planScaffold } from "@octant/domain";
import { Sparkles } from "lucide-react";
import { useState } from "react";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantInput } from "../ui/base/OctantInput";

export interface ScaffoldPickerProps {
  readonly entries: ReadonlyArray<ScaffoldEntry>;
  readonly runnable: ReadonlyMap<string, boolean>;
  readonly busy: boolean;
  readonly message?: string;
  readonly lastRun?: ScaffoldRun;
  readonly onStart: (entry: ScaffoldEntry, directoryName: string) => void;
}

/**
 * The scaffolds this host offers, and what each one will do.
 *
 * The exact command is shown before anything runs, because a scaffold
 * downloads and executes a generator and the person approving it should be
 * reading the same line the host is about to run.
 */
export function ScaffoldPicker(props: ScaffoldPickerProps) {
  const [selected, setSelected] = useState<string>();
  const [directoryName, setDirectoryName] = useState("");
  const entry = props.entries.find((candidate) => String(candidate.id) === selected);
  const named = directoryName.trim();
  // The same composition the host runs, shown before it is approved. The host
  // decides; this is only so the person deciding reads the actual command.
  const preview =
    entry === undefined || named.length === 0
      ? undefined
      : planScaffold({
          entry,
          directoryName: named,
          posture: "approval-gated",
          availableTools: [entry.requiresTool],
          targetExists: false,
        });

  return (
    <section aria-label="Start a project" className="scaffolds">
      <header className="scaffolds__header">
        <Sparkles aria-hidden="true" size={13} strokeWidth={1.8} />
        <span>Start a project</span>
      </header>

      <ul className="scaffolds__list">
        {props.entries.map((candidate) => {
          const id = String(candidate.id);
          const runnable = props.runnable.get(id) === true;
          return (
            <li className="scaffolds__entry" key={id}>
              <OctantButton
                aria-pressed={selected === id}
                className="scaffolds__entry-button"
                disabled={!runnable || props.busy}
                onClick={() => setSelected(selected === id ? undefined : id)}
                type="button"
                variant="ghost"
              >
                <span className="scaffolds__entry-name">{candidate.displayName}</span>
                <span className="scaffolds__entry-summary">{candidate.summary}</span>
              </OctantButton>
              {runnable ? null : (
                <p className="scaffolds__entry-blocked">
                  Needs {candidate.requiresTool}, which is not on this machine.
                </p>
              )}
            </li>
          );
        })}
      </ul>

      {entry === undefined ? null : (
        <div className="scaffolds__start">
          <label className="scaffolds__label" htmlFor="scaffold-directory">
            New directory
          </label>
          <OctantInput
            className="scaffolds__input"
            id="scaffold-directory"
            maxLength={64}
            onChange={(event) => setDirectoryName(event.target.value)}
            placeholder="my-project"
            value={directoryName}
          />
          <p className="scaffolds__produces">Writes {entry.produces.join(", ")}</p>
          {preview?.status !== "planned" ? null : (
            <p className="scaffolds__command">
              Runs <code>{preview.argv.join(" ")}</code>
            </p>
          )}
          <OctantButton
            disabled={props.busy || named.length === 0}
            onClick={() => props.onStart(entry, named)}
            size="sm"
            type="button"
            variant="secondary"
          >
            Start it
          </OctantButton>
        </div>
      )}

      {props.message === undefined ? null : (
        <p className="scaffolds__message" role="status">
          {props.message}
        </p>
      )}

      {props.lastRun === undefined ? null : (
        <pre aria-label="Scaffold output" className="scaffolds__output">
          {props.lastRun.output}
          {props.lastRun.outputTruncated ? "\n…" : ""}
        </pre>
      )}
    </section>
  );
}
