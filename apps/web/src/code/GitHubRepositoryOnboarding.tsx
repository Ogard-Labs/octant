import { useEffect, useState } from "react";
import { ChevronDown, FolderGit2 } from "lucide-react";
import type { GithubClient } from "@octant/client-runtime/github-client";
import type { GithubCloneClient } from "@octant/client-runtime/github-clone-client";
import type {
  GithubCloneBindingReceipt,
  GithubCloneOperation,
  GithubCloneRefusalReason,
  GithubRepositoryRow,
} from "@octant/contracts";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantPopover } from "../ui/base/OctantPopover";
import { GITHUB_VISIBILITY_LABELS, GitHubRepositoryPicker } from "./GitHubRepositoryPicker";

/**
 * The Code composer's GitHub repository selection and
 * managed-clone flow. The GitHub repository stays a distinct visible
 * selection next to Host and Octant Project: an existing Project fixes its
 * repository, so combining it with a GitHub selection fails closed instead of
 * silently rebinding. Every effect is server-confirmed — this control only
 * requests, confirms with the server-issued digest, renders polled progress,
 * and turns the returned one-time binding receipt into one ordinary Code
 * Project. Refusals, failures, cancellation, and recovery are honest states;
 * the draft and the repository selection survive all of them.
 */

export interface GitHubRepositoryOnboardingProps {
  readonly client: GithubClient;
  readonly cloneClient: GithubCloneClient;
  /** Display name of the authoritative execution host shown in confirmations. */
  readonly hostName: string;
  /**
   * Set when the composer has an existing Code Project selected. That Project
   * fixes host and repository, so the GitHub flow fails closed.
   */
  readonly fixedProjectName?: string;
  /** Creates the ordinary Code Project from the one-time binding receipt. */
  readonly createProject: (name: string, receiptId: string) => Promise<string | undefined>;
  readonly onProjectCreated?: (projectId: string, name: string) => void;
  readonly disabled?: boolean;
  readonly pollIntervalMs?: number;
}

type FlowPhase =
  | { readonly kind: "pick" }
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

export function GitHubRepositoryOnboarding(props: GitHubRepositoryOnboardingProps) {
  const { cloneClient, createProject, onProjectCreated } = props;
  const pollIntervalMs = props.pollIntervalMs ?? 700;
  const [open, setOpen] = useState(false);
  const [selection, setSelection] = useState<GithubRepositoryRow>();
  const [phase, setPhase] = useState<FlowPhase>({ kind: "pick" });
  const mismatch = props.fixedProjectName !== undefined && selection !== undefined;
  // A successful onboarding selects the Project it just created, which makes
  // `fixedProjectName` defined. The fail-closed guard only protects flows
  // that have not yet reached Project creation.
  const settled =
    phase.kind === "creating-project" ||
    phase.kind === "project-failed" ||
    phase.kind === "completed";

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

  const requestClone = async (row: GithubRepositoryRow) => {
    setPhase({ kind: "requesting" });
    const requestId = crypto.randomUUID();
    try {
      const response = await cloneClient.execute({
        kind: "request-clone",
        requestId,
        nodeId: row.nodeId,
        expectedOwner: row.owner,
        expectedName: row.name,
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

  const triggerText =
    phase.kind === "running"
      ? `Cloning ${selection?.owner}/${selection?.name}…`
      : selection === undefined
        ? "GitHub repository"
        : `${selection.owner}/${selection.name}`;

  return (
    <span className="github-onboarding">
      <OctantPopover
        align="start"
        className="github-onboarding__dialog"
        onOpenChange={setOpen}
        open={open}
        side="bottom"
        sideOffset={6}
        title="GitHub repository"
        trigger={
          <>
            <FolderGit2 aria-hidden="true" size={12} strokeWidth={1.5} />
            <span>{triggerText}</span>
            <ChevronDown aria-hidden="true" size={12} strokeWidth={1.5} />
          </>
        }
        triggerClassName="github-onboarding__trigger"
        {...(props.disabled === undefined ? {} : { triggerDisabled: props.disabled })}
        triggerLabel="GitHub repository"
        triggerVariant="ghost"
      >
        {props.fixedProjectName !== undefined && !settled ? (
          mismatch ? (
            <div className="github-onboarding__body">
              <p role="alert">
                The GitHub repository selection ({selection.owner}/{selection.name}) conflicts with
                the selected Project. “{props.fixedProjectName}” already binds its repository and
                host, so Octant will not rebind it.
              </p>
              <p className="github-onboarding__note">
                Clear the Project selection to onboard this GitHub repository, or clear the GitHub
                selection to keep working in “{props.fixedProjectName}”.
              </p>
              <div className="github-onboarding__actions">
                <OctantButton
                  onClick={() => {
                    setSelection(undefined);
                    setPhase({ kind: "pick" });
                  }}
                  size="sm"
                  type="button"
                  variant="secondary"
                >
                  Clear GitHub selection
                </OctantButton>
                <OctantButton
                  onClick={() => setOpen(false)}
                  size="sm"
                  type="button"
                  variant="ghost"
                >
                  Close
                </OctantButton>
              </div>
            </div>
          ) : (
            <div className="github-onboarding__body">
              <p>
                “{props.fixedProjectName}” already binds its repository and host. Choose No Project
                in the composer to onboard a different GitHub repository.
              </p>
              <div className="github-onboarding__actions">
                <OctantButton
                  onClick={() => setOpen(false)}
                  size="sm"
                  type="button"
                  variant="ghost"
                >
                  Close
                </OctantButton>
              </div>
            </div>
          )
        ) : (
          <FlowBody
            hostName={props.hostName}
            client={props.client}
            phase={phase}
            selection={selection}
            onPick={(row) => {
              setSelection(row);
              void requestClone(row);
            }}
            onConfirm={(operation) => void confirm(operation)}
            onCancelClone={(operation) => void cancel(operation)}
            onBackToPicker={() => setPhase({ kind: "pick" })}
            onRetryRequest={() => {
              if (selection !== undefined) void requestClone(selection);
            }}
            onRetryProjectCreation={(receipt, operation) =>
              void runCreateProject(receipt, operation)
            }
            onDone={() => setOpen(false)}
          />
        )}
      </OctantPopover>
    </span>
  );
}

interface FlowBodyProps {
  readonly client: GithubClient;
  readonly hostName: string;
  readonly phase: FlowPhase;
  readonly selection: GithubRepositoryRow | undefined;
  readonly onPick: (row: GithubRepositoryRow) => void;
  readonly onConfirm: (operation: GithubCloneOperation) => void;
  readonly onCancelClone: (operation: GithubCloneOperation) => void;
  readonly onBackToPicker: () => void;
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
          onBack={props.onBackToPicker}
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
            <OctantButton
              onClick={props.onBackToPicker}
              size="sm"
              type="button"
              variant="secondary"
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
            <OctantButton
              onClick={props.onRetryRequest}
              size="sm"
              type="button"
              variant="secondary"
            >
              Try again
            </OctantButton>
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
            <OctantButton
              onClick={props.onRetryRequest}
              size="sm"
              type="button"
              variant="secondary"
            >
              Try again
            </OctantButton>
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
