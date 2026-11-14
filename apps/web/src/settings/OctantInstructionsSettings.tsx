import type { OctantInstructionsClient } from "@octant/client-runtime/octant-instructions-client";
import type { OctantInstructionsView } from "@octant/contracts/octant-instructions";
import {
  OCTANT_INSTRUCTIONS_LIMITS,
  octantInstructionsWithinLimit,
  type OctantInstructionsText,
} from "@octant/domain/octant-instructions-policy";
import { looksLikeSecret } from "@octant/domain/secret-shaped-text-policy";
import { useCallback, useEffect, useId, useState } from "react";
import { OctantAlert } from "../ui/base/OctantAlert";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantTextarea } from "../ui/base/OctantTextarea";
import { SettingRow, SettingsState } from "./primitives";
import "./octant-instructions.css";

export const YOUR_INSTRUCTIONS_PURPOSE =
  "Rules for working inside Octant, sent with every new turn on every provider: which provider or model takes which job, and when to use Work, Canvas, routines, or the board. A provider's own instruction files still apply and come first on how it works.";

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
  const fieldId = useId();
  const countId = useId();
  useEffect(() => setDraft(props.value), [props.value]);
  const limit = OCTANT_INSTRUCTIONS_LIMITS[props.text];
  const fits = octantInstructionsWithinLimit(props.text, draft);
  const changed = draft !== props.value;
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
            aria-describedby={countId}
            aria-invalid={fits ? undefined : true}
            id={fieldId}
            onChange={(event) => setDraft(event.target.value)}
            readOnly={!props.canChange}
            rows={6}
            value={draft}
          />
          {props.canChange && looksLikeSecret(draft) ? (
            <OctantAlert tone="warning">{INSTRUCTIONS_SECRET_WARNING}</OctantAlert>
          ) : null}
          {props.problem === undefined ? null : (
            <OctantAlert tone="danger">{props.problem}</OctantAlert>
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
              <span className="octant-instructions-field__note">{INSTRUCTIONS_READ_ONLY_NOTE}</span>
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
  const [problem, setProblem] = useState<string>();

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

  async function save(instructions: string) {
    if (client === undefined || view === undefined) return;
    setBusy(true);
    setProblem(undefined);
    try {
      const result = await client.change({
        kind: "change-person-instructions",
        expectedVersion: view.version,
        instructions,
      });
      if (result.kind === "octant-instructions") {
        setView(result);
        return;
      }
      setProblem(result.message);
      if (result.reason === "stale-version") await load();
    } catch {
      setProblem("Your instructions could not be saved.");
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
    <InstructionsField
      busy={busy}
      canChange={view.canChange}
      focused={props.focusedSetting === "your-instructions"}
      label="Your instructions"
      onSave={(value) => void save(value)}
      problem={problem}
      purpose={YOUR_INSTRUCTIONS_PURPOSE}
      scope="host"
      settingId="your-instructions"
      text="person"
      value={view.instructions}
    />
  );
}
