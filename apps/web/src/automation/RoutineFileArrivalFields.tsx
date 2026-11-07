import { useId } from "react";
import { OctantInput } from "../ui/base/OctantInput";
import type { RoutineScheduleFormState } from "./RoutineScheduleFields";

/** The file-trigger variant of the existing routine schedule form. */
export function RoutineFileArrivalFields(props: {
  readonly mode?: "work" | "code";
  readonly trigger: RoutineScheduleFormState;
  readonly onChange: (
    update: (previous: RoutineScheduleFormState) => RoutineScheduleFormState,
  ) => void;
}) {
  const ids = {
    directory: useId(),
    directoryHelp: useId(),
    extensions: useId(),
    extensionsHelp: useId(),
    exclusions: useId(),
    exclusionsHelp: useId(),
    settle: useId(),
    limit: useId(),
    preview: useId(),
  };
  const change = (
    field:
      | "fileDirectory"
      | "fileExtensions"
      | "fileExclusions"
      | "settleSeconds"
      | "automaticStartLimit",
    value: string,
  ) => props.onChange((previous) => ({ ...previous, [field]: value }));
  const { trigger } = props;
  return (
    <>
      <div className="automation-editor__field">
        <label htmlFor={ids.directory}>Input folder in this Project</label>
        <OctantInput
          className="input"
          id={ids.directory}
          aria-describedby={ids.directoryHelp}
          value={trigger.fileDirectory}
          onChange={(event) => change("fileDirectory", event.target.value)}
          placeholder="Inbox"
        />
        <p className="automation-editor__note" id={ids.directoryHelp}>
          Choose an existing folder relative to the main Project folder; use . for the Project root.
        </p>
      </div>
      <div className="automation-editor__field">
        <label htmlFor={ids.extensions}>File suffixes</label>
        <OctantInput
          className="input"
          id={ids.extensions}
          aria-describedby={ids.extensionsHelp}
          value={trigger.fileExtensions}
          onChange={(event) => change("fileExtensions", event.target.value)}
          placeholder="pdf, txt"
        />
        <p className="automation-editor__note" id={ids.extensionsHelp}>
          Comma-separated suffixes, or leave blank for all permitted regular files.
        </p>
      </div>
      <div className="automation-editor__field">
        <label htmlFor={ids.exclusions}>Excluded folders</label>
        <OctantInput
          className="input"
          id={ids.exclusions}
          aria-describedby={ids.exclusionsHelp}
          value={trigger.fileExclusions}
          onChange={(event) => change("fileExclusions", event.target.value)}
          placeholder="processed, output"
        />
        <p className="automation-editor__note" id={ids.exclusionsHelp}>
          Comma-separated folders relative to the input folder; a separate output folder helps avoid
          feedback.
        </p>
      </div>
      <div className="automation-editor__field">
        <label htmlFor={ids.settle}>Settling time (seconds)</label>
        <OctantInput
          className="input"
          id={ids.settle}
          type="number"
          min={2}
          max={60}
          value={trigger.settleSeconds}
          onChange={(event) => change("settleSeconds", event.target.value)}
        />
      </div>
      <div className="automation-editor__field">
        <label htmlFor={ids.limit}>Automatic runs per arm</label>
        <OctantInput
          className="input"
          id={ids.limit}
          aria-describedby={ids.preview}
          type="number"
          min={1}
          max={32}
          value={trigger.automaticStartLimit}
          onChange={(event) => change("automaticStartLimit", event.target.value)}
        />
      </div>
      <section
        className="automation-editor__field"
        aria-label="File arrival preview"
        id={ids.preview}
      >
        <h4>Before enabling</h4>
        <p>
          Set up and re-arm from a window on this host. Runs the fixed task in a new{" "}
          {props.mode === "code" ? "Code" : "Work"} thread, under the Project, profile, level and
          delivery you choose here.
        </p>
        {props.mode === "code" ? (
          <p>
            The exact observed inputs are copied into the run's own checkout. Changed or missing
            source bytes stop admission. Existing different files are never overwritten. Review
            copied inputs before committing or pushing.
          </p>
        ) : null}
        <ul>
          <li>The first complete scan is a baseline; existing files do not start a run.</li>
          <li>
            At most {trigger.automaticStartLimit || "8"} automatic runs per arm, then review and
            re-arm; quiet time and restarting do not reset the limit.
          </li>
          <li>
            Matching changes while the routine or known Project activity is busy are held for
            review; Octant cannot tell which program wrote a file.
          </li>
          <li>
            The host must be running. After a gap, the chosen missed-run policy sees only net
            changed files that still exist, not every missed event.
          </li>
          <li>
            Hidden entries, symbolic links, excluded folders and protected files are ignored; an
            unreadable, replaced or oversized source blocks observation.
          </li>
        </ul>
      </section>
    </>
  );
}
