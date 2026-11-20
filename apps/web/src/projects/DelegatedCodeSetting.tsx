import {
  decodeCodeProjectDelegatedCode,
  type CodeProjectDelegatedCode,
} from "@octant/contracts/projects";
import { useId, useState } from "react";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantInput } from "../ui/base/OctantInput";
import { OctantSelectField } from "../ui/base/OctantSelect";
import { OctantSwitch } from "../ui/base/OctantSwitch";

type Outcome = CodeProjectDelegatedCode["outcomeKind"];

const OUTCOMES: ReadonlyArray<{ readonly id: Outcome; readonly label: string }> = [
  { id: "local-implementation", label: "Commits on the thread's branch" },
  { id: "opened-pr", label: "An opened pull request" },
  { id: "investigation-result", label: "A written answer, no changes" },
];

const OUTCOME_LINE: Readonly<Record<Outcome, string>> = {
  "investigation-result": "a written answer",
  "local-implementation": "commits on its own branch",
  "opened-pr": "an opened pull request",
  "merged-pr": "a merged pull request",
};

/**
 * Whether a Code Project takes Code work other computers in the hub delegate
 * to it, and the delivery target its person confirms for that work: each
 * delegated thread gets its own branch from this remote and base branch and
 * asks before it acts. Turning it on is confirming that target, so the switch
 * opens the form rather than sending at once.
 */
export function DelegatedCodeSetting(props: {
  readonly disabled: boolean;
  readonly delegatedCode: CodeProjectDelegatedCode | undefined;
  readonly onChange: (delegatedCode: CodeProjectDelegatedCode | undefined) => Promise<boolean>;
  readonly now?: () => Date;
}) {
  const descriptionId = useId();
  const remoteId = useId();
  const branchId = useId();
  const [pending, setPending] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [remoteName, setRemoteName] = useState("origin");
  const [baseBranch, setBaseBranch] = useState("main");
  const [outcomeKind, setOutcomeKind] = useState<Outcome>("local-implementation");
  const send = (delegatedCode: CodeProjectDelegatedCode | undefined) => {
    setPending(true);
    void props
      .onChange(delegatedCode)
      .then((changed) => {
        if (changed) setConfirming(false);
      })
      .finally(() => setPending(false));
  };
  const marked = props.delegatedCode;
  const ready = remoteName.trim() !== "" && baseBranch.trim() !== "";
  return (
    <section className="project-overview-inspector">
      <div className="project-overview-inspector__row">
        <div>
          <h3>Delegated Code work</h3>
          <p id={descriptionId}>
            {marked === undefined
              ? "Other computers in your hub can ask this Project for Code work. Each request gets its own thread and branch here, asks before it acts, and is answered only here. Only this computer's person can change this."
              : `Delegated threads start from ${marked.remoteName}/${marked.baseBranch} on their own branch and aim at ${OUTCOME_LINE[marked.outcomeKind]}. They ask before they act and are answered only here.`}
          </p>
        </div>
        <OctantSwitch
          checked={marked !== undefined || confirming}
          describedBy={descriptionId}
          disabled={props.disabled || pending}
          label="Take Code work from other computers"
          onCheckedChange={(on) => {
            if (on) setConfirming(true);
            else if (marked === undefined) setConfirming(false);
            else send(undefined);
          }}
        />
      </div>
      {confirming && marked === undefined ? (
        <form
          aria-label="Confirm the delivery target for delegated Code work"
          className="settings-panel__stack"
          onSubmit={(event) => {
            event.preventDefault();
            if (!ready) return;
            send(
              decodeCodeProjectDelegatedCode({
                remoteName: remoteName.trim(),
                baseBranch: baseBranch.trim(),
                outcomeKind,
                confirmedAt: (props.now?.() ?? new Date()).toISOString(),
              }),
            );
          }}
        >
          <label htmlFor={remoteId}>Remote</label>
          <OctantInput
            id={remoteId}
            onChange={(event) => setRemoteName(event.target.value)}
            value={remoteName}
          />
          <label htmlFor={branchId}>Base branch</label>
          <OctantInput
            id={branchId}
            onChange={(event) => setBaseBranch(event.target.value)}
            value={baseBranch}
          />
          <OctantSelectField
            aria-label="What a delegated thread delivers"
            onValueChange={(value) => {
              const chosen = OUTCOMES.find((outcome) => outcome.id === value);
              if (chosen !== undefined) setOutcomeKind(chosen.id);
            }}
            options={OUTCOMES.map((outcome) => ({ id: outcome.id, label: outcome.label }))}
            value={outcomeKind}
          />
          <div className="host-settings__controls">
            <OctantButton disabled={!ready || pending} size="sm" type="submit" variant="default">
              Take delegated Code work
            </OctantButton>
            <OctantButton
              onClick={() => setConfirming(false)}
              size="sm"
              type="button"
              variant="ghost"
            >
              Cancel
            </OctantButton>
          </div>
        </form>
      ) : null}
    </section>
  );
}
