import { useEffect, useState } from "react";
import { FolderOpen } from "lucide-react";
import type { GithubClient } from "@octant/client-runtime/github-client";
import type { GithubCloneClient } from "@octant/client-runtime/github-clone-client";
import type {
  GithubCloneBindingReceipt,
  GithubCloneOperation,
  GithubCloneRefusalReason,
  GithubRepositoryRow,
} from "@octant/contracts";
import { decodeBindingReceiptId } from "@octant/contracts/projects";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantInput } from "../ui/base/OctantInput";
import { GITHUB_VISIBILITY_LABELS, GitHubRepositoryPicker } from "./GitHubRepositoryPicker";

/**
 * The managed-clone flow that turns a GitHub repository into one ordinary
 * Code Project. It lives inside the composer's Project menu as "New Project
 * from GitHub repository". Every effect is server-confirmed: this control
 * only requests, confirms with the server-issued digest, renders polled
 * progress, and turns the returned one-time binding receipt into a Project.
 * Refusals, failures, cancellation, and recovery are honest states; the
 * repository selection survives all of them so a retry needs no re-pick.
 */

export interface GithubCloneDestinationChoice {
  /** One host-issued parent-folder receipt from the native picker or folder browser. */
  readonly receiptId: string;
  readonly displayName: string;
}

export interface GitHubRepositoryOnboardingFlowProps {
  readonly client: GithubClient;
  readonly cloneClient: GithubCloneClient;
  /** Display name of the authoritative execution host shown in confirmations. */
  readonly hostName: string;
  /** Creates the ordinary Code Project from the one-time binding receipt. */
  readonly createProject: (name: string, receiptId: string) => Promise<string | undefined>;
  readonly onProjectCreated?: (projectId: string, name: string) => void;
  /**
   * When present, the person chooses the parent folder and folder name the
   * checkout lands in before anything is requested. Absent keeps the host's
   * managed repository inventory as the destination.
   */
  readonly chooseDestination?: () => Promise<GithubCloneDestinationChoice | undefined>;
  /** Done on the completed step; the owner closes whatever holds the flow. */
  readonly onDone: () => void;
  readonly pollIntervalMs?: number;
}

type FlowPhase =
  | { readonly kind: "pick" }
  | { readonly kind: "destination"; readonly repository: GithubRepositoryRow }
  | { readonly kind: "requesting" }
  | { readonly kind: "confirm"; readonly operation: GithubCloneOperation }
  | {
      readonly kind: "running";
      readonly operation: GithubCloneOperation;
      readonly progressMessage?: string;
    }
  | {
      readonly kind: "refused";
      readonly reason: GithubCloneRefusalReason;
      readonly remediation?: string;
    }
  | { readonly kind: "failed"; readonly operation: GithubCloneOperation }
  | { readonly kind: "cancelled" }
  | {
      readonly kind: "creating-project";
      readonly receipt: GithubCloneBindingReceipt;
      readonly operation: GithubCloneOperation;
    }
  | {
      readonly kind: "project-failed";
      readonly receipt: GithubCloneBindingReceipt;
      readonly operation: GithubCloneOperation;
    }
  | { readonly kind: "completed"; readonly projectName: string };

const REFUSAL_FALLBACKS: Readonly<Record<GithubCloneRefusalReason, string>> = {
  unauthorized: "GitHub is not connected on this host. Set it up in Settings.",
  "capability-unavailable": "The GitHub repository catalogue is unavailable on this host.",
  "stale-read": "The repository facts were stale. Refresh the picker and try again.",
  "non-https-git-protocol":
    "The host's gh Git protocol is not HTTPS. Reconfigure gh for HTTPS, then retry.",
  invalid: "The clone request was invalid.",
  conflict: "Another operation already owns this repository or destination.",
  "not-found": "The repository could not be resolved on GitHub.",
  collision: "The destination already contains something else. Resolve it on the host.",
  unavailable: "The managed clone service is unavailable.",
};

const PROGRESS_PHASE_LABELS: Readonly<Record<string, string>> = {
  cloning: "Cloning",
  verifying: "Verifying",
  attaching: "Attaching",
};

export function GitHubRepositoryOnboardingFlow(props: GitHubRepositoryOnboardingFlowProps) {
  const { cloneClient, createProject, onProjectCreated } = props;
  const chooseDestination = props.chooseDestination;
  const pollIntervalMs = props.pollIntervalMs ?? 700;
  const [selection, setSelection] = useState<GithubRepositoryRow>();
  const [destination, setDestination] = useState<GithubCloneDestinationChoice>();
  const [folderName, setFolderName] = useState("");
  const [phase, setPhase] = useState<FlowPhase>({ kind: "pick" });

  // Poll bounded, redacted progress while the confirmed pipeline runs. The
  // command response itself resolves with the terminal operation.
  const runningRequestId = phase.kind === "running" ? phase.operation.requestId : undefined;
  useEffect(() => {
    if (runningRequestId === undefined) return;
    const interval = setInterval(() => {
      void cloneClient
        .listOperations()
        .then((list) => {
          const entry = list.operations.find(
            (candidate) => candidate.operation.requestId === runningRequestId,
          );
          if (entry === undefined) return;
          setPhase((current) => {
            if (current.kind !== "running") return current;
            const message =
              entry.progress === undefined
                ? undefined
                : `${PROGRESS_PHASE_LABELS[entry.progress.phase] ?? entry.progress.phase}…${
                    entry.progress.message === undefined ? "" : ` ${entry.progress.message}`
                  }`;
            return {
              kind: "running",
              operation: entry.operation,
              ...(message === undefined ? {} : { progressMessage: message }),
            };
          });
        })
        .catch(() => undefined);
    }, pollIntervalMs);
    return () => clearInterval(interval);
  }, [cloneClient, pollIntervalMs, runningRequestId]);

  const requestClone = async (row: GithubRepositoryRow, chosen?: GithubCloneDestinationChoice) => {
    setPhase({ kind: "requesting" });
    const requestId = crypto.randomUUID();
    try {
      const response = await cloneClient.execute({
        kind: "request-clone",
        requestId,
        nodeId: row.nodeId,
        expectedOwner: row.owner,
        expectedName: row.name,
        ...(chosen === undefined
          ? {}
          : {
              destination: {
                parentReceiptId: decodeBindingReceiptId(chosen.receiptId),
                folderName: folderName.trim(),
              },
            }),
      });
      if (response.kind === "refused") {
        setPhase({
          kind: "refused",
          reason: response.reason,
          ...(response.remediation === undefined ? {} : { remediation: response.remediation }),
        });
        return;
      }
      setPhase({ kind: "confirm", operation: response.operation });
    } catch (error) {
      setPhase({
        kind: "refused",
        reason: "unavailable",
        ...(error instanceof Error ? { remediation: error.message } : {}),
      });
    }
  };

  const runCreateProject = async (
    receipt: GithubCloneBindingReceipt,
    operation: GithubCloneOperation,
  ) => {
    setPhase({ kind: "creating-project", receipt, operation });
    try {
      const projectId = await createProject(operation.repository.name, receipt.receiptId);
      if (projectId === undefined) {
        setPhase({ kind: "project-failed", receipt, operation });
        return;
      }
      setPhase({ kind: "completed", projectName: operation.repository.name });
      onProjectCreated?.(projectId, operation.repository.name);
    } catch {
      setPhase({ kind: "project-failed", receipt, operation });
    }
  };

  const confirm = async (operation: GithubCloneOperation) => {
    setPhase({ kind: "running", operation });
    try {
      const response = await cloneClient.execute(
        operation.mode === "clone"
          ? {
              kind: "confirm-clone",
              requestId: operation.requestId,
              nodeId: operation.repository.nodeId,
              confirmation: "confirm-github-managed-clone",
              destinationDigest: operation.destination.digest,
            }
          : {
              kind: "attach-existing",
              requestId: operation.requestId,
              nodeId: operation.repository.nodeId,
              confirmation: "confirm-github-attach-existing",
              destinationDigest: operation.destination.digest,
            },
      );
      if (response.kind === "refused") {
        setPhase({
          kind: "refused",
          reason: response.reason,
          ...(response.remediation === undefined ? {} : { remediation: response.remediation }),
        });
        return;
      }
      const terminal = response.operation;
      if (terminal.state === "completed" && response.binding !== undefined) {
        await runCreateProject(response.binding, terminal);
      } else if (terminal.state === "cancelled") {
        setPhase({ kind: "cancelled" });
      } else {
        setPhase({ kind: "failed", operation: terminal });
      }
    } catch (error) {
      setPhase({
        kind: "refused",
        reason: "unavailable",
        ...(error instanceof Error ? { remediation: error.message } : {}),
      });
    }
  };

  const cancel = async (operation: GithubCloneOperation) => {
    try {
      await cloneClient.execute({ kind: "cancel-clone", requestId: operation.requestId });
      setPhase({ kind: "cancelled" });
    } catch {
      // The confirm command still owns the terminal outcome; leave the
      // running state to resolve honestly instead of pretending cancellation.
    }
  };

  /**
   * A chosen parent folder arrives as a one-time receipt that the request
   * consumes, so returning to the destination step always asks for a fresh
   * folder selection rather than replaying a spent receipt.
   */
  const returnToDestination = () => {
    if (selection === undefined || chooseDestination === undefined) return;
    setDestination(undefined);
    setPhase({ kind: "destination", repository: selection });
  };

  const backFromConfirm = (operation: GithubCloneOperation) => {
    if (chooseDestination === undefined) {
      setPhase({ kind: "pick" });
      return;
    }
    void cloneClient
      .execute({ kind: "cancel-clone", requestId: operation.requestId })
      .catch(() => undefined);
    returnToDestination();
  };

  return (
    <FlowBody
      hostName={props.hostName}
      client={props.client}
      phase={phase}
      selection={selection}
      destination={destination}
      folderName={folderName}
      {...(chooseDestination === undefined ? {} : { chooseDestination })}
      onPick={(row) => {
        setSelection(row);
        if (chooseDestination === undefined) {
          void requestClone(row);
          return;
        }
        setFolderName(row.name);
        setPhase({ kind: "destination", repository: row });
      }}
      onChooseDestination={(choice) => setDestination(choice)}
      onFolderNameChange={setFolderName}
      onContinueToRequest={() => {
        if (selection === undefined || destination === undefined) return;
        void requestClone(selection, destination);
      }}
      onConfirm={(operation) => void confirm(operation)}
      onCancelClone={(operation) => void cancel(operation)}
      onBackToPicker={() => setPhase({ kind: "pick" })}
      {...(chooseDestination !== undefined && selection !== undefined
        ? { onBackToDestination: returnToDestination }
        : {})}
      onBackFromConfirm={backFromConfirm}
      onRetryRequest={() => {
        if (selection !== undefined) void requestClone(selection);
      }}
      onRetryProjectCreation={(receipt, operation) => void runCreateProject(receipt, operation)}
      onDone={props.onDone}
    />
  );
}

interface FlowBodyProps {
  readonly client: GithubClient;
  readonly hostName: string;
  readonly phase: FlowPhase;
  readonly selection: GithubRepositoryRow | undefined;
  readonly destination: GithubCloneDestinationChoice | undefined;
  readonly folderName: string;
  readonly chooseDestination?: () => Promise<GithubCloneDestinationChoice | undefined>;
  readonly onPick: (row: GithubRepositoryRow) => void;
  readonly onChooseDestination: (choice: GithubCloneDestinationChoice) => void;
  readonly onFolderNameChange: (name: string) => void;
  readonly onContinueToRequest: () => void;
  readonly onConfirm: (operation: GithubCloneOperation) => void;
  readonly onCancelClone: (operation: GithubCloneOperation) => void;
  readonly onBackToPicker: () => void;
  readonly onBackToDestination?: () => void;
  readonly onBackFromConfirm: (operation: GithubCloneOperation) => void;
  readonly onRetryRequest: () => void;
  readonly onRetryProjectCreation: (
    receipt: GithubCloneBindingReceipt,
    operation: GithubCloneOperation,
  ) => void;
  readonly onDone: () => void;
}

function FlowBody(props: FlowBodyProps) {
  const { phase } = props;
  switch (phase.kind) {
    case "pick":
      return (
        <div className="github-onboarding__body">
          <h2 className="github-onboarding__heading">Choose a GitHub repository</h2>
          <GitHubRepositoryPicker
            client={props.client}
            onSelect={props.onPick}
            {...(props.selection === undefined ? {} : { selectedNodeId: props.selection.nodeId })}
          />
        </div>
      );
    case "destination":
      return props.chooseDestination === undefined ? null : (
        <DestinationStep
          chooseDestination={props.chooseDestination}
          destination={props.destination}
          folderName={props.folderName}
          hostName={props.hostName}
          onBack={props.onBackToPicker}
          onChoose={props.onChooseDestination}
          onContinue={props.onContinueToRequest}
          onFolderNameChange={props.onFolderNameChange}
          repository={phase.repository}
        />
      );
    case "requesting":
      return (
        <div className="github-onboarding__body">
          <p role="status">Preparing the managed clone…</p>
        </div>
      );
    case "confirm":
      return (
        <ConfirmationCard
          hostName={props.hostName}
          onBack={() => props.onBackFromConfirm(phase.operation)}
          onConfirm={() => props.onConfirm(phase.operation)}
          operation={phase.operation}
        />
      );
    case "running":
      return (
        <div className="github-onboarding__body">
          <p role="status">
            {phase.progressMessage ??
              `${PROGRESS_PHASE_LABELS[phase.operation.state] ?? "Working"}…`}
          </p>
          <div className="github-onboarding__actions">
            <OctantButton
              onClick={() => props.onCancelClone(phase.operation)}
              size="sm"
              type="button"
              variant="secondary"
            >
              Cancel clone
            </OctantButton>
          </div>
        </div>
      );
    case "refused":
      return (
        <div className="github-onboarding__body">
          <p role="alert">{phase.remediation ?? REFUSAL_FALLBACKS[phase.reason]}</p>
          <div className="github-onboarding__actions">
            {props.onBackToDestination === undefined ? null : (
              <OctantButton
                onClick={props.onBackToDestination}
                size="sm"
                type="button"
                variant="secondary"
              >
                Change destination
              </OctantButton>
            )}
            <OctantButton
              onClick={props.onBackToPicker}
              size="sm"
              type="button"
              variant={props.onBackToDestination === undefined ? "secondary" : "ghost"}
            >
              Choose another repository
            </OctantButton>
          </div>
        </div>
      );
    case "failed":
      return (
        <div className="github-onboarding__body">
          <p role="alert">
            {phase.operation.failure?.remediation ?? "The managed clone did not complete."}
          </p>
          <p className="github-onboarding__note">
            Failure code: {phase.operation.failure?.code ?? "unavailable"}. No partial checkout was
            attached; any staging remains quarantined on the host.
          </p>
          <div className="github-onboarding__actions">
            {props.onBackToDestination === undefined ? (
              <OctantButton
                onClick={props.onRetryRequest}
                size="sm"
                type="button"
                variant="secondary"
              >
                Try again
              </OctantButton>
            ) : (
              <OctantButton
                onClick={props.onBackToDestination}
                size="sm"
                type="button"
                variant="secondary"
              >
                Change destination
              </OctantButton>
            )}
            <OctantButton onClick={props.onBackToPicker} size="sm" type="button" variant="ghost">
              Choose another repository
            </OctantButton>
          </div>
        </div>
      );
    case "cancelled":
      return (
        <div className="github-onboarding__body">
          <p role="status">The clone was cancelled. Nothing was attached.</p>
          <div className="github-onboarding__actions">
            {props.onBackToDestination === undefined ? (
              <OctantButton
                onClick={props.onRetryRequest}
                size="sm"
                type="button"
                variant="secondary"
              >
                Try again
              </OctantButton>
            ) : (
              <OctantButton
                onClick={props.onBackToDestination}
                size="sm"
                type="button"
                variant="secondary"
              >
                Change destination
              </OctantButton>
            )}
            <OctantButton onClick={props.onBackToPicker} size="sm" type="button" variant="ghost">
              Choose another repository
            </OctantButton>
          </div>
        </div>
      );
    case "creating-project":
      return (
        <div className="github-onboarding__body">
          <p role="status">Creating the Code Project…</p>
        </div>
      );
    case "project-failed":
      return (
        <div className="github-onboarding__body">
          <p role="alert">
            Project creation failed. The verified checkout remains on the host and is never deleted;
            retry now or attach it again later.
          </p>
          <div className="github-onboarding__actions">
            <OctantButton
              onClick={() => props.onRetryProjectCreation(phase.receipt, phase.operation)}
              size="sm"
              type="button"
              variant="secondary"
            >
              Retry Project creation
            </OctantButton>
          </div>
        </div>
      );
    case "completed":
      return (
        <div className="github-onboarding__body">
          <p role="status">
            The Code Project is ready. “{phase.projectName}” is bound to the verified checkout.
          </p>
          <div className="github-onboarding__actions">
            <OctantButton onClick={props.onDone} size="sm" type="button" variant="secondary">
              Done
            </OctantButton>
          </div>
        </div>
      );
  }
}

/**
 * The destination step for the Create Project dialog: the person picks the
 * parent folder through a host-issued binding receipt and names the folder
 * the checkout will occupy. The server derives and previews the exact final
 * path on the next step; nothing here sends a path.
 */
function DestinationStep(props: {
  readonly hostName: string;
  readonly repository: GithubRepositoryRow;
  readonly destination: GithubCloneDestinationChoice | undefined;
  readonly folderName: string;
  readonly chooseDestination: () => Promise<GithubCloneDestinationChoice | undefined>;
  readonly onChoose: (choice: GithubCloneDestinationChoice) => void;
  readonly onFolderNameChange: (name: string) => void;
  readonly onContinue: () => void;
  readonly onBack: () => void;
}) {
  const [choosing, setChoosing] = useState(false);

  const choose = async () => {
    if (choosing) return;
    setChoosing(true);
    try {
      const choice = await props.chooseDestination();
      if (choice !== undefined) props.onChoose(choice);
    } finally {
      setChoosing(false);
    }
  };

  const valid = props.destination !== undefined && props.folderName.trim() !== "";
  return (
    <div className="github-onboarding__body">
      <h2 className="github-onboarding__heading">Where should it be cloned?</h2>
      <p className="github-onboarding__note">
        {props.repository.owner}/{props.repository.name} will be cloned into a folder you choose on{" "}
        {props.hostName}.
      </p>
      <p className="project-dialog__field-label" id="github-clone-parent-label">
        Clone into
      </p>
      <OctantButton
        aria-describedby="github-clone-parent-label"
        className="project-dialog__folder"
        data-chosen={props.destination === undefined ? "false" : "true"}
        disabled={choosing}
        onClick={() => void choose()}
        type="button"
        variant="ghost"
      >
        <FolderOpen aria-hidden="true" size={16} strokeWidth={1.6} />
        <span className="project-dialog__folder-name">
          {props.destination?.displayName ??
            (choosing ? "Waiting for the folder chooser…" : "Choose a folder")}
        </span>
        {props.destination === undefined ? null : (
          <span className="project-dialog__folder-change">Change</span>
        )}
      </OctantButton>
      <label className="project-dialog__field-label" htmlFor="github-clone-folder-name">
        Folder name
      </label>
      <OctantInput
        id="github-clone-folder-name"
        onChange={(event) => props.onFolderNameChange(event.target.value)}
        placeholder={props.repository.name}
        value={props.folderName}
      />
      <div className="github-onboarding__actions">
        <OctantButton disabled={!valid} onClick={props.onContinue} size="sm" type="button">
          Continue
        </OctantButton>
        <OctantButton onClick={props.onBack} size="sm" type="button" variant="ghost">
          Back
        </OctantButton>
      </div>
    </div>
  );
}

function ConfirmationCard(props: {
  readonly hostName: string;
  readonly operation: GithubCloneOperation;
  readonly onConfirm: () => void;
  readonly onBack: () => void;
}) {
  const { operation } = props;
  const attach = operation.mode === "attach-existing";
  return (
    <div className="github-onboarding__body">
      <h2 className="github-onboarding__heading">
        {attach ? "Confirm attach" : "Confirm managed clone"}
      </h2>
      <dl className="github-onboarding__facts">
        <dt>Host</dt>
        <dd>{props.hostName}</dd>
        <dt>Repository</dt>
        <dd>
          {operation.repository.owner}/{operation.repository.name}
        </dd>
        <dt>Visibility</dt>
        <dd>{GITHUB_VISIBILITY_LABELS[operation.repository.visibility]}</dd>
        <dt>Default branch</dt>
        <dd>{operation.repository.defaultBranch ?? "Unknown"}</dd>
        <dt>Destination</dt>
        <dd>{operation.destination.destinationPath}</dd>
      </dl>
      <p className="github-onboarding__note">
        This operation requires the network, credential, and managed-repository-create approvals on{" "}
        {props.hostName}.
      </p>
      {attach ? (
        <p className="github-onboarding__note">
          A verified checkout of this repository already exists at the destination. Octant will
          attach it without cloning.
        </p>
      ) : (
        <p className="github-onboarding__note">
          Octant will create a managed folder at the destination inside the host's repository
          inventory. Nothing outside that folder is touched.
        </p>
      )}
      <div className="github-onboarding__actions">
        <OctantButton onClick={props.onConfirm} size="sm" type="button" variant="default">
          {attach ? "Attach existing checkout" : "Clone repository"}
        </OctantButton>
        <OctantButton onClick={props.onBack} size="sm" type="button" variant="ghost">
          Back
        </OctantButton>
      </div>
    </div>
  );
}
