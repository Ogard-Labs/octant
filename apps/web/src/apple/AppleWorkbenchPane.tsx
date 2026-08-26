import type { AppleDiscoverySnapshot } from "@octant/contracts/apple-toolchain-rpc";
import type {
  AppleActionProgress,
  AppleBuildEvidence,
  AppleRuntimeSnapshot,
  AppleSimulatorId,
  AppleSimulatorRecord,
} from "@octant/contracts/apple-toolchain";
import { OctantButton } from "../ui/base/OctantButton";

export type AppleWorkbenchStatus =
  | "loading"
  | "waiting"
  | "unavailable"
  | "interrupted"
  | "failed"
  | "ready";

/**
 * What the reader asked the workbench to do.
 *
 * A build or test names no destination; everything else names the exact
 * Simulator it acts on. The pane never invents that identity — it offers only
 * the actions a Simulator in its reported state can actually perform, and hands
 * back the one the reader chose for the surface above to authorize.
 */
export type AppleWorkbenchIntent =
  | { readonly kind: "build" | "test" }
  | {
      readonly kind: "run" | "boot" | "shutdown" | "screenshot";
      readonly simulatorId: AppleSimulatorId;
    };

export interface AppleWorkbenchPaneProps {
  readonly status: AppleWorkbenchStatus;
  readonly discovery?: AppleDiscoverySnapshot;
  readonly runtime?: AppleRuntimeSnapshot;
  readonly errorMessage?: string;
  readonly onRetry?: () => void;
  /** Absent when this surface may only read: no control is offered at all. */
  readonly onRun?: (intent: AppleWorkbenchIntent) => void;
  readonly onCancel?: (actionId: AppleActionProgress["actionId"]) => void;
  /** True while a request this pane started is still in flight. */
  readonly busy?: boolean;
  readonly actionMessage?: string;
}

export function AppleWorkbenchPane(props: AppleWorkbenchPaneProps) {
  if (props.status !== "ready") return <AppleWorkbenchState {...props} />;
  if (props.discovery === undefined || props.runtime === undefined) {
    return <AppleWorkbenchState status="waiting" />;
  }
  return (
    <section aria-label="Apple development workbench" className="apple-workbench">
      <header className="apple-workbench__header">
        <div>
          <span className="apple-workbench__eyebrow">Apple development</span>
          <h1>{props.discovery.workspace.projectPath}</h1>
        </div>
        <span className="apple-workbench__toolchain">
          Xcode {props.discovery.toolchain.xcodeVersion ?? "unavailable"}
        </span>
      </header>
      <dl className="apple-workbench__facts">
        <Fact label="Scheme" value={props.discovery.workspace.schemes[0] ?? "Not selected"} />
        <Fact label="Revision" value={props.discovery.workspace.sourceRevision.slice(0, 12)} />
        <Fact label="SDKs" value={String(props.discovery.toolchain.sdks.length)} />
        <Fact label="Simulators" value={String(props.discovery.simulators.length)} />
      </dl>
      {props.onRun === undefined ? null : (
        <WorkspaceActions
          busy={props.busy === true}
          onRun={props.onRun}
          scheme={props.discovery.workspace.schemes[0]}
        />
      )}
      {props.actionMessage === undefined ? null : (
        <p className="apple-workbench__action-message" role="alert">
          {props.actionMessage}
        </p>
      )}
      <SimulatorList
        busy={props.busy === true}
        {...(props.onRun === undefined ? {} : { onRun: props.onRun })}
        scheme={props.discovery.workspace.schemes[0]}
        simulators={props.discovery.simulators}
      />
      <ProgressList
        busy={props.busy === true}
        {...(props.onCancel === undefined ? {} : { onCancel: props.onCancel })}
        progress={props.runtime.active}
      />
      <EvidenceList evidence={props.runtime.recentEvidence} />
    </section>
  );
}

function AppleWorkbenchState(
  props: Pick<AppleWorkbenchPaneProps, "status" | "errorMessage" | "onRetry">,
) {
  const presentation = {
    loading: ["Loading Apple toolchain", "Discovering Xcode, SDKs, and Simulator destinations."],
    waiting: [
      "Waiting for Apple evidence",
      "No authoritative Apple action state is available yet.",
    ],
    unavailable: [
      "Apple toolchain unavailable",
      "Install or select Xcode and an available Simulator runtime, then retry.",
    ],
    interrupted: [
      "Apple action interrupted",
      "The owned process stopped before a verified result was recorded.",
    ],
    failed: [
      "Apple action failed",
      props.errorMessage ?? "Review the normalized diagnostics and retry.",
    ],
    ready: ["Waiting for Apple evidence", "No authoritative Apple action state is available yet."],
  } as const;
  const [title, message] = presentation[props.status];
  return (
    <section
      aria-label="Apple development workbench"
      className={`apple-workbench apple-workbench--${props.status}`}
    >
      <span className="apple-workbench__eyebrow">Apple development</span>
      <h1>{title}</h1>
      <p role={props.status === "failed" ? "alert" : undefined}>{message}</p>
      {props.onRetry === undefined ? null : (
        <OctantButton onClick={props.onRetry} type="button" variant="outline">
          Retry
        </OctantButton>
      )}
    </section>
  );
}

function Fact(props: { readonly label: string; readonly value: string }) {
  return (
    <div>
      <dt>{props.label}</dt>
      <dd>{props.value}</dd>
    </div>
  );
}

/**
 * Build and test, which name no destination.
 *
 * A workspace with no scheme has nothing to build, and the pane says so rather
 * than offering a button that would be refused.
 */
function WorkspaceActions(props: {
  readonly busy: boolean;
  readonly onRun: (intent: AppleWorkbenchIntent) => void;
  readonly scheme: string | undefined;
}) {
  const scheme = props.scheme;
  if (scheme === undefined) {
    return (
      <section aria-labelledby="apple-actions-heading" className="apple-workbench__section">
        <h2 id="apple-actions-heading">Actions</h2>
        <p>This workspace reports no scheme to build.</p>
      </section>
    );
  }
  return (
    <section aria-labelledby="apple-actions-heading" className="apple-workbench__section">
      <h2 id="apple-actions-heading">Actions</h2>
      <div className="apple-workbench__actions">
        {/* Peer scheme actions: neither is the one primary of the pane. */}
        <OctantButton
          aria-label={`Build ${scheme}`}
          disabled={props.busy}
          onClick={() => props.onRun({ kind: "build" })}
          type="button"
          variant="secondary"
        >
          Build
        </OctantButton>
        <OctantButton
          aria-label={`Test ${scheme}`}
          disabled={props.busy}
          onClick={() => props.onRun({ kind: "test" })}
          type="button"
          variant="secondary"
        >
          Test
        </OctantButton>
      </div>
    </section>
  );
}

function SimulatorList(props: {
  readonly busy: boolean;
  readonly onRun?: (intent: AppleWorkbenchIntent) => void;
  readonly scheme: string | undefined;
  readonly simulators: ReadonlyArray<AppleSimulatorRecord>;
}) {
  return (
    <section aria-labelledby="apple-simulators-heading" className="apple-workbench__section">
      <h2 id="apple-simulators-heading">Simulator destinations</h2>
      {props.simulators.length === 0 ? (
        <p>No compatible Simulator is available.</p>
      ) : (
        <ul>
          {props.simulators.map((simulator) => (
            <li key={simulator.simulatorId}>
              <strong>{simulator.name}</strong>
              <span>
                {simulator.platform} {simulator.runtimeVersion} · {simulatorState(simulator.state)}
              </span>
              {props.onRun === undefined ? null : (
                <SimulatorActions
                  busy={props.busy}
                  onRun={props.onRun}
                  scheme={props.scheme}
                  simulator={simulator}
                />
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * The actions this Simulator can take from the state the host reports.
 *
 * A shutdown Simulator has no screen to capture and no app to run; a booted one
 * cannot be booted again. Offering either would be a control the host refuses.
 */
function SimulatorActions(props: {
  readonly busy: boolean;
  readonly onRun: (intent: AppleWorkbenchIntent) => void;
  readonly scheme: string | undefined;
  readonly simulator: AppleSimulatorRecord;
}) {
  const { simulator } = props;
  const booted = simulator.state === "booted";
  const disabled = props.busy || simulator.state === "unavailable";
  return (
    <span className="apple-workbench__actions">
      {booted ? null : (
        <OctantButton
          aria-label={`Boot ${simulator.name}`}
          disabled={disabled || simulator.state !== "shutdown"}
          onClick={() => props.onRun({ kind: "boot", simulatorId: simulator.simulatorId })}
          type="button"
          variant="secondary"
        >
          Boot
        </OctantButton>
      )}
      {!booted ? null : (
        <>
          {props.scheme === undefined ? null : (
            <OctantButton
              aria-label={`Run ${props.scheme} on ${simulator.name}`}
              disabled={disabled}
              onClick={() => props.onRun({ kind: "run", simulatorId: simulator.simulatorId })}
              type="button"
              variant="secondary"
            >
              Run
            </OctantButton>
          )}
          <OctantButton
            aria-label={`Capture the ${simulator.name} screen`}
            disabled={disabled}
            onClick={() => props.onRun({ kind: "screenshot", simulatorId: simulator.simulatorId })}
            type="button"
            variant="secondary"
          >
            Capture screen
          </OctantButton>
          <OctantButton
            aria-label={`Shut down ${simulator.name}`}
            disabled={disabled}
            onClick={() => props.onRun({ kind: "shutdown", simulatorId: simulator.simulatorId })}
            type="button"
            variant="destructive"
          >
            Shut down
          </OctantButton>
        </>
      )}
    </span>
  );
}

function ProgressList(props: {
  readonly busy: boolean;
  readonly onCancel?: (actionId: AppleActionProgress["actionId"]) => void;
  readonly progress: ReadonlyArray<AppleActionProgress>;
}) {
  return (
    <section aria-labelledby="apple-progress-heading" className="apple-workbench__section">
      <h2 id="apple-progress-heading">Current progress</h2>
      {props.progress.length === 0 ? (
        <p>No Apple action is running.</p>
      ) : (
        <ol>
          {props.progress.map((progress) => (
            <li key={progress.actionId}>
              <strong>{actionLabel(progress.kind)}</strong>
              <span>{stepLabel(progress.step)}</span>
              {props.onCancel === undefined || progress.state === "completed" ? null : (
                <OctantButton
                  aria-label={`Cancel ${actionLabel(progress.kind)}`}
                  disabled={props.busy}
                  onClick={() => props.onCancel?.(progress.actionId)}
                  type="button"
                  variant="ghost"
                >
                  Cancel
                </OctantButton>
              )}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

function EvidenceList(props: { readonly evidence: ReadonlyArray<AppleBuildEvidence> }) {
  return (
    <section aria-labelledby="apple-evidence-heading" className="apple-workbench__section">
      <h2 id="apple-evidence-heading">Validation evidence</h2>
      {props.evidence.length === 0 ? (
        <p>No Apple evidence has been recorded.</p>
      ) : (
        <ol>
          {[...props.evidence].reverse().map((item) => (
            <li key={`${item.actionId}:${item.completedAt}`}>
              <div>
                <strong>{actionLabel(item.kind)}</strong>
                <span>{outcomeLabel(item.outcome)}</span>
                {item.cleanup === "uncertain" ? <span>Cleanup uncertain</span> : null}
              </div>
              {item.diagnostics.length === 0 ? null : (
                <ul aria-label="Diagnostics">
                  {item.diagnostics.map((diagnostic, index) => (
                    <li key={`${diagnostic.severity}:${index}`}>
                      {diagnostic.severity}: {diagnostic.message}
                    </li>
                  ))}
                </ul>
              )}
              {item.artifacts.length === 0 ? null : (
                <ul aria-label="Artifacts">
                  {item.artifacts.map((artifact) => (
                    <li key={`${artifact.kind}:${artifact.reference}`}>
                      {artifact.kind}: <code>{artifact.reference}</code>
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

function actionLabel(kind: string): string {
  return `${kind.charAt(0).toUpperCase()}${kind.slice(1)}`;
}

function stepLabel(step: AppleActionProgress["step"]): string {
  return step
    .split("-")
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

function simulatorState(state: AppleSimulatorRecord["state"]): string {
  return state === "shutting-down" ? "Shutting down" : actionLabel(state);
}

function outcomeLabel(outcome: AppleBuildEvidence["outcome"]): string {
  const labels: Record<AppleBuildEvidence["outcome"], string> = {
    succeeded: "Succeeded",
    failed: "Failed",
    cancelled: "Cancelled",
    "timed-out": "Timed out",
    interrupted: "Interrupted",
    unavailable: "Unavailable",
    unauthorized: "Unauthorized",
    "invalid-destination": "Invalid destination",
    "process-died": "Process died",
  };
  return labels[outcome];
}
