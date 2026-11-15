import type { OctantInstructionsClient } from "@octant/client-runtime/octant-instructions-client";
import {
  decodeOctantInstructionsCommand,
  type OctantInstructionsView,
  type ProjectInstructionsView,
} from "@octant/contracts/octant-instructions";
import {
  OCTANT_INSTRUCTIONS_LIMITS,
  octantInstructionsWithinLimit,
  type OctantInstructionsText,
} from "@octant/domain/octant-instructions-policy";
import { looksLikeSecret } from "@octant/domain/secret-shaped-text-policy";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { OctantAlert } from "../ui/base/OctantAlert";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantTextarea } from "../ui/base/OctantTextarea";
import { SettingRow, SettingsState } from "./primitives";
import "./octant-instructions.css";

export const YOUR_INSTRUCTIONS_PURPOSE =
  "Rules for working inside Octant, sent with every new turn on every provider: which provider or model takes which job, and when to use Work, Canvas, routines, or the board. A provider's own instruction files still apply and come first on how it works.";

export const ORCHESTRATION_PURPOSE =
  "For coordinator threads and a Project's planner only, after your instructions: when to start a worker, which provider and model suits which task, how workers report back, and when to stop and ask. It grants nothing; a coordinator's start setting and bounds still apply.";

export const PROJECT_INSTRUCTIONS_PURPOSE =
  "Rules for this Project's threads in Octant, sent after your instructions with every new turn in this Project. A provider's own instruction files in the folder still apply and come first on how it works.";

export const INSTRUCTIONS_READ_ONLY_NOTE =
  "Only you can change these, from a window on this computer or a device you paired.";

export const INSTRUCTIONS_SECRET_WARNING =
  "This looks like it holds a key or password. Everything here is sent to the model with every turn; keep secrets in Secret stores instead.";

const numberFormat = new Intl.NumberFormat("en-US");

export interface InstructionsFieldProps {
  readonly settingId: string;
  readonly label: string;
  readonly purpose: string;
  readonly text: OctantInstructionsText;
  readonly value: string;
  readonly canChange: boolean;
  readonly busy: boolean;
  readonly problem?: string | undefined;
  readonly focused?: boolean;
  readonly scope: "host" | "project";
  readonly onSave: (value: string) => void;
}

/**
 * One of the person's texts: a multi-line field with its count and limit, a
 * line saying what it is for, and Save. A window that cannot change the text
 * shows it read-only and says who can.
 */
export function InstructionsField(props: InstructionsFieldProps) {
  const [draft, setDraft] = useState(props.value);
  const seeded = useRef(props.value);
  const fieldId = useId();
  const countId = useId();
  const secretId = useId();
  const problemId = useId();
  const noteId = useId();
  // A new text from the host replaces the field only when the person has not
  // typed over the last one. A stale refusal rereads the host's text, and the
  // person's unsaved draft must survive it so Save can retry on the new version.
  useEffect(() => {
    const previous = seeded.current;
    seeded.current = props.value;
    setDraft((current) => (current === previous ? props.value : current));
  }, [props.value]);
  const limit = OCTANT_INSTRUCTIONS_LIMITS[props.text];
  const fits = octantInstructionsWithinLimit(props.text, draft);
  const changed = draft !== props.value;
  const warnsOfSecret = props.canChange && looksLikeSecret(draft);
  const describedBy = [
    `${props.settingId}-description`,
    warnsOfSecret ? secretId : undefined,
    props.problem === undefined ? undefined : problemId,
    countId,
    props.canChange ? undefined : noteId,
  ]
    .filter((id) => id !== undefined)
    .join(" ");
  return (
    <div className="octant-instructions-row">
      <SettingRow
        description={props.purpose}
        focused={props.focused === true}
        htmlFor={fieldId}
        label={props.label}
        scope={props.scope}
        settingId={props.settingId}
      >
        <div className="octant-instructions-field">
          <OctantTextarea
            aria-describedby={describedBy}
            aria-invalid={fits ? undefined : true}
            id={fieldId}
            onChange={(event) => setDraft(event.target.value)}
            readOnly={!props.canChange}
            rows={6}
            value={draft}
          />
          {warnsOfSecret ? (
            <OctantAlert id={secretId} tone="warning">
              {INSTRUCTIONS_SECRET_WARNING}
            </OctantAlert>
          ) : null}
          {props.problem === undefined ? null : (
            <OctantAlert id={problemId} tone="danger">
              {props.problem}
            </OctantAlert>
          )}
          <div className="octant-instructions-field__foot">
            <span
              className="octant-instructions-field__count"
              data-over={fits ? "false" : "true"}
              id={countId}
            >
              {numberFormat.format(draft.length)} / {numberFormat.format(limit)} characters
            </span>
            {props.canChange ? (
              <OctantButton
                disabled={props.busy || !changed || !fits}
                onClick={() => props.onSave(draft)}
                size="sm"
                type="button"
                variant="secondary"
              >
                Save
              </OctantButton>
            ) : (
              <span className="octant-instructions-field__note" id={noteId}>
                {INSTRUCTIONS_READ_ONLY_NOTE}
              </span>
            )}
          </div>
        </div>
      </SettingRow>
    </div>
  );
}

export interface OctantInstructionsSettingsProps {
  /** Absent where the window has no host to ask. */
  readonly client: OctantInstructionsClient | undefined;
  readonly focusedSetting?: string | undefined;
}

/** Settings › General, under Your identity: the instructions you write for Octant. */
export function OctantInstructionsSettings(props: OctantInstructionsSettingsProps) {
  const { client } = props;
  const [view, setView] = useState<OctantInstructionsView>();
  const [loadFailed, setLoadFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<{
    readonly field: "instructions" | "orchestration";
    readonly message: string;
  }>();

  const load = useCallback(async () => {
    if (client === undefined) return;
    try {
      setView(await client.read());
      setLoadFailed(false);
    } catch {
      setLoadFailed(true);
    }
  }, [client]);

  useEffect(() => {
    void load();
  }, [load]);

  async function save(field: "instructions" | "orchestration", text: string) {
    if (client === undefined || view === undefined) return;
    setBusy(true);
    setProblem(undefined);
    try {
      const result = await client.change(
        field === "instructions"
          ? {
              kind: "change-person-instructions",
              expectedVersion: view.version,
              instructions: text,
            }
          : {
              kind: "change-orchestration-instructions",
              expectedVersion: view.orchestrationVersion,
              orchestration: text,
            },
      );
      if (result.kind === "octant-instructions") {
        setView(result);
        return;
      }
      if (result.kind === "octant-instructions-refused") {
        setProblem({ field, message: result.message });
        if (result.reason === "stale-version") await load();
      }
    } catch {
      setProblem({ field, message: "Your instructions could not be saved." });
    } finally {
      setBusy(false);
    }
  }

  if (client === undefined || view === undefined) {
    return (
      <SettingRow
        description={YOUR_INSTRUCTIONS_PURPOSE}
        label="Your instructions"
        scope="host"
        settingId="your-instructions"
      >
        <SettingsState kind={client !== undefined && !loadFailed ? "loading" : "empty"}>
          {client === undefined
            ? "Shown where Octant runs."
            : loadFailed
              ? "Your instructions could not be read from this host."
              : "Reading your instructions…"}
        </SettingsState>
      </SettingRow>
    );
  }
  return (
    <>
      <InstructionsField
        busy={busy}
        canChange={view.canChange}
        focused={props.focusedSetting === "your-instructions"}
        label="Your instructions"
        onSave={(value) => void save("instructions", value)}
        problem={problem?.field === "instructions" ? problem.message : undefined}
        purpose={YOUR_INSTRUCTIONS_PURPOSE}
        scope="host"
        settingId="your-instructions"
        text="person"
        value={view.instructions}
      />
      <InstructionsField
        busy={busy}
        canChange={view.canChange}
        focused={props.focusedSetting === "orchestration-instructions"}
        label="Orchestration"
        onSave={(value) => void save("orchestration", value)}
        problem={problem?.field === "orchestration" ? problem.message : undefined}
        purpose={ORCHESTRATION_PURPOSE}
        scope="host"
        settingId="orchestration-instructions"
        text="orchestration"
        value={view.orchestration}
      />
    </>
  );
}

export interface ProjectInstructionsSettingsProps {
  readonly client: OctantInstructionsClient;
  readonly projectId: string;
  /** An archived or stale Project shows its text without Save. */
  readonly readOnly?: boolean;
}

/** A Project's settings, beside Project memory: the person's instructions for this Project. */
export function ProjectInstructionsSettings(props: ProjectInstructionsSettingsProps) {
  const { client, projectId } = props;
  const [view, setView] = useState<ProjectInstructionsView>();
  const [problem, setProblem] = useState<string>();
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const result = await client.readProject(projectId);
      if (result.kind === "project-instructions") {
        setView(result);
        setProblem(undefined);
      } else if (result.kind === "octant-instructions-refused") {
        setProblem(result.message);
      }
    } catch {
      setProblem("This Project's instructions could not be read from this host.");
    }
  }, [client, projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function save(instructions: string) {
    if (view === undefined) return;
    setBusy(true);
    setProblem(undefined);
    try {
      const result = await client.change(
        decodeOctantInstructionsCommand({
          kind: "change-project-instructions",
          projectId,
          expectedVersion: view.version,
          instructions,
        }),
      );
      if (result.kind === "project-instructions") {
        setView(result);
        return;
      }
      if (result.kind === "octant-instructions-refused") {
        // The reread clears the problem when it succeeds, so the refusal is
        // shown after it; otherwise the person keeps a draft with no reason.
        if (result.reason === "stale-version") await load();
        setProblem(result.message);
      }
    } catch {
      setProblem("This Project's instructions could not be saved.");
    } finally {
      setBusy(false);
    }
  }

  if (view === undefined) {
    return (
      <SettingsState kind={problem === undefined ? "loading" : "error"}>
        {problem ?? "Reading this Project's instructions…"}
      </SettingsState>
    );
  }
  return (
    <InstructionsField
      busy={busy}
      canChange={view.canChange && props.readOnly !== true}
      label="Project instructions"
      onSave={(value) => void save(value)}
      problem={problem}
      purpose={PROJECT_INSTRUCTIONS_PURPOSE}
      scope="project"
      settingId="project-instructions"
      text="project"
      value={view.instructions}
    />
  );
}
