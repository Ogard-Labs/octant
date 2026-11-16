import type { ScaffoldEntry, ScaffoldRun } from "@octant/contracts/scaffolds";
import { planScaffold } from "@octant/domain";
import { ChevronRight, Code2, Globe, type IconComponent, TabletSmartphone } from "../ui/icons";
import { useState } from "react";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantInput } from "../ui/base/OctantInput";

/** One glyph per kind of project, so a row reads before its words are read. */
const KIND_ICONS: Readonly<Record<ScaffoldEntry["target"], IconComponent>> = {
  "web-app": Globe,
  "cross-platform-app": TabletSmartphone,
  "native-apple-app": Code2,
};

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
    <section aria-label="Start from a template" className="empty-start__group">
      <h3 className="oct-section-label empty-start__label">Start from a template</h3>
      <ul className="empty-start__rows">
        {props.entries.map((candidate) => {
          const id = String(candidate.id);
          const runnable = props.runnable.get(id) === true;
          const KindIcon = KIND_ICONS[candidate.target];
          return (
            <li className="empty-start__row-item" key={id}>
              <OctantButton
                aria-pressed={selected === id}
                className="empty-start__row empty-start__row--action"
                disabled={!runnable || props.busy}
                onClick={() => setSelected(selected === id ? undefined : id)}
                type="button"
                variant="bare"
              >
                <KindIcon aria-hidden={true} className="empty-start__icon" size={16} />
                <span className="empty-start__text">
                  <span className="empty-start__name">{candidate.displayName}</span>
                  {runnable ? (
                    <span className="empty-start__summary">{candidate.summary}</span>
                  ) : (
                    <span className="empty-start__summary">
                      Needs {candidate.requiresTool}, which is not on this machine.
                    </span>
                  )}
                </span>
                <ChevronRight aria-hidden={true} className="empty-start__chevron" size={16} />
              </OctantButton>
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
