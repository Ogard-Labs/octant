import "../styles/repository-bootstrap-dialog.css";
import {
  RepositoryBootstrapClientFailure,
  createRepositoryBootstrapClient,
  type RepositoryBootstrapClient,
  type RepositoryBootstrapClientOptions,
} from "@octant/client-runtime/repository-bootstrap-client";
import { AggregateVersion } from "@octant/contracts/events";
import { LOCAL_HOST_ID, type HostId } from "@octant/contracts/host";
import { decodeProjectId, type ProjectId, type ProjectSummary } from "@octant/contracts/projects";
import { Schema } from "effect";
import {
  decodeRepositoryBootstrapOperationId,
  type RepositoryBootstrapFilePayload,
  type RepositoryBootstrapFailureCode,
  type RepositoryBootstrapInspectResult,
  type RepositoryBootstrapLandFileFailure,
  type RepositoryBootstrapOperationId,
  type RepositoryCloneTransport,
} from "@octant/contracts/repository-bootstrap";
import { X } from "../ui/icons";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import {
  destinationNeedsProject,
  type BootstrapDestinationTarget,
} from "../host/useBootstrapDestinations";
import { homeRelativePath } from "../lib/homeRelativePath";
import { OctantAlert } from "../ui/base/OctantAlert";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantCheckbox } from "../ui/base/OctantCheckbox";
import { OctantDialog } from "../ui/base/OctantDialog";
import { OctantField, OctantFieldLabel } from "../ui/base/OctantField";
import { OctantInput } from "../ui/base/OctantInput";
import { OctantSelectField } from "../ui/base/OctantSelect";
import { OctantToggleGroup, OctantToggleGroupItem } from "../ui/base/OctantToggleGroup";

const CLONE_POLL_INTERVAL_MS = 350;
const LAND_BATCH_MAX_RAW_BYTES = 2 * 1024 * 1024;

type CodeProjectSummary = Extract<ProjectSummary, { readonly type: "code" }>;

export interface AddRepositoryToComputerCompleted {
  readonly destinationHostId: HostId;
  readonly projectId: ProjectId;
  readonly projectName: string;
}

export interface AddRepositoryToComputerDialogProps {
  readonly open: boolean;
  readonly sourceHostName: string;
  /** Fixed local Code Project, when opened from that Project's overview or row menu. */
  readonly project?: CodeProjectSummary;
  /** Selectable local Code Projects, when opened from a paired computer's Code surface. */
  readonly localProjects?: ReadonlyArray<CodeProjectSummary>;
  readonly destinations: ReadonlyArray<BootstrapDestinationTarget>;
  readonly initialDestinationHostId?: HostId;
  readonly sourceBootstrapClient?: RepositoryBootstrapClient;
  readonly sourceBootstrapPort?: RepositoryBootstrapClientOptions;
  readonly onClose: () => void;
  readonly onCompleted?: (result: AddRepositoryToComputerCompleted) => void;
}

type RunPhase =
  | { readonly kind: "idle" }
  | {
      readonly kind: "running";
      readonly stage: "cloning" | "binding" | "copying";
      readonly operationId: RepositoryBootstrapOperationId;
      readonly detail: string;
    }
  | {
      readonly kind: "failed";
      readonly code: RepositoryBootstrapFailureCode;
      readonly message: string;
    }
  | {
      readonly kind: "partial-copy";
      readonly completed: AddRepositoryToComputerCompleted;
      readonly landedCount: number;
      readonly failed: ReadonlyArray<RepositoryBootstrapLandFileFailure>;
    };

export function AddRepositoryToComputerDialog(props: AddRepositoryToComputerDialogProps) {
  const titleId = useId();
  const folderInputId = useId();
  const eligibleDestinations = useMemo(() => {
    const eligible = props.destinations.filter((target) => target.actsAsHostPerson);
    const project = props.project;
    if (project === undefined) return eligible;
    return [
      ...eligible.filter((target) => destinationNeedsProject(target, project)),
      ...eligible.filter((target) => !destinationNeedsProject(target, project)),
    ];
  }, [props.destinations, props.project]);
  const selectableProjects = useMemo(
    () => (props.project !== undefined ? [props.project] : (props.localProjects ?? [])),
    [props.project, props.localProjects],
  );

  const [selectedProjectId, setSelectedProjectId] = useState<string>(() =>
    selectableProjects[0] === undefined ? "" : String(selectableProjects[0].id),
  );
  const [selectedHostId, setSelectedHostId] = useState<string>(() => {
    if (
      props.initialDestinationHostId !== undefined &&
      eligibleDestinations.some(
        (target) => String(target.hostId) === String(props.initialDestinationHostId),
      )
    ) {
      return String(props.initialDestinationHostId);
    }
    return eligibleDestinations[0] === undefined ? "" : String(eligibleDestinations[0].hostId);
  });

  const activeProject =
    selectableProjects.find((item) => String(item.id) === selectedProjectId) ??
    selectableProjects[0];
  const activeDestination =
    eligibleDestinations.find((item) => String(item.hostId) === selectedHostId) ??
    eligibleDestinations[0];

  const [inspectState, setInspectState] = useState<
    | { readonly kind: "loading" }
    | { readonly kind: "ready"; readonly data: RepositoryBootstrapInspectResult }
    | { readonly kind: "error"; readonly message: string }
  >({ kind: "loading" });

  const [transport, setTransport] = useState<RepositoryCloneTransport>("ssh");
  const [destinationPath, setDestinationPath] = useState("");
  const [selectedFiles, setSelectedFiles] = useState<ReadonlySet<string>>(() => new Set());
  const [phase, setPhase] = useState<RunPhase>({ kind: "idle" });

  const resolvedSourceClient = useMemo(
    () =>
      props.sourceBootstrapClient ??
      (props.sourceBootstrapPort === undefined
        ? undefined
        : createRepositoryBootstrapClient(props.sourceBootstrapPort)),
    [props.sourceBootstrapClient, props.sourceBootstrapPort],
  );
  const destinationClientsRef = useRef(
    new WeakMap<RepositoryBootstrapClientOptions, RepositoryBootstrapClient>(),
  );
  const resolveDestinationClient = (
    target: BootstrapDestinationTarget,
  ): RepositoryBootstrapClient | undefined => {
    if (target.bootstrapClient !== undefined) return target.bootstrapClient;
    if (target.bootstrapPort === undefined) return undefined;
    let client = destinationClientsRef.current.get(target.bootstrapPort);
    if (client === undefined) {
      client = createRepositoryBootstrapClient(target.bootstrapPort);
      destinationClientsRef.current.set(target.bootstrapPort, client);
    }
    return client;
  };

  const runAbortRef = useRef<AbortController | undefined>(undefined);
  const activeRunTargetRef = useRef<
    | {
        readonly client: RepositoryBootstrapClient;
        readonly operationId: RepositoryBootstrapOperationId;
      }
    | undefined
  >(undefined);
  const wasOpenRef = useRef(false);
  const lastInspectedProjectIdRef = useRef<string | undefined>(undefined);

  // Reset form defaults and run phase only when the dialog opens (never when
  // parent polling refreshes the destinations array during an active run or
  // partial-copy summary).
  useEffect(() => {
    const justOpened = props.open && !wasOpenRef.current;
    wasOpenRef.current = props.open;
    if (!props.open) {
      lastInspectedProjectIdRef.current = undefined;
      return;
    }
    if (!justOpened) return;

    if (props.project !== undefined) {
      setSelectedProjectId(String(props.project.id));
    } else if (selectableProjects[0] !== undefined) {
      setSelectedProjectId(String(selectableProjects[0].id));
    }
    if (props.initialDestinationHostId !== undefined) {
      setSelectedHostId(String(props.initialDestinationHostId));
    } else if (eligibleDestinations[0] !== undefined) {
      setSelectedHostId(String(eligibleDestinations[0].hostId));
    }
    setPhase({ kind: "idle" });
  }, [
    props.open,
    props.project,
    props.initialDestinationHostId,
    selectableProjects,
    eligibleDestinations,
  ]);

  // Keep selected project/destination valid while idle if the available lists change.
  useEffect(() => {
    if (!props.open || phase.kind !== "idle") return;
    if (props.project !== undefined) {
      setSelectedProjectId(String(props.project.id));
    } else if (
      selectableProjects[0] !== undefined &&
      !selectableProjects.some((item) => String(item.id) === selectedProjectId)
    ) {
      setSelectedProjectId(String(selectableProjects[0].id));
    }
    if (
      eligibleDestinations[0] !== undefined &&
      !eligibleDestinations.some((item) => String(item.hostId) === selectedHostId)
    ) {
      setSelectedHostId(String(eligibleDestinations[0].hostId));
    }
  }, [
    props.open,
    phase.kind,
    props.project,
    selectableProjects,
    eligibleDestinations,
    selectedProjectId,
    selectedHostId,
  ]);

  // Inspect the selected local Code Project whenever it changes while open.
  useEffect(() => {
    if (!props.open || activeProject === undefined || resolvedSourceClient === undefined) return;
    const projectKey = String(activeProject.id);
    if (lastInspectedProjectIdRef.current === projectKey) return;
    lastInspectedProjectIdRef.current = projectKey;

    const controller = new AbortController();
    let settled = false;
    setInspectState({ kind: "loading" });
    setSelectedFiles(new Set());
    setPhase((current) => (current.kind === "running" ? current : { kind: "idle" }));

    void resolvedSourceClient
      .inspect({ projectId: activeProject.id }, controller.signal)
      .then((result) => {
        if (controller.signal.aborted) return;
        settled = true;
        setInspectState({ kind: "ready", data: result });
        setDestinationPath(result.defaultDestinationPath);
        const preferred =
          result.remotes.defaultTransport ??
          (result.remotes.sshUrl !== undefined ? "ssh" : "https");
        setTransport(preferred);
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        settled = true;
        setInspectState({
          kind: "error",
          message:
            error instanceof Error
              ? error.message
              : "Could not inspect this repository for cloning.",
        });
      });

    return () => {
      controller.abort();
      if (!settled && lastInspectedProjectIdRef.current === projectKey) {
        lastInspectedProjectIdRef.current = undefined;
      }
    };
  }, [props.open, activeProject?.id, resolvedSourceClient]);

  // Clean up any in-flight client abort when unmounting.
  useEffect(
    () => () => {
      runAbortRef.current?.abort();
    },
    [],
  );

  const inspectData = inspectState.kind === "ready" ? inspectState.data : undefined;
  const sshUrl = inspectData?.remotes.sshUrl;
  const httpsUrl = inspectData?.remotes.httpsUrl;
  const resolvedRemoteUrl = transport === "ssh" ? sshUrl : httpsUrl;
  const ignoredFiles = inspectData?.ignoredFiles ?? [];
  const totalIgnoredCount = ignoredFiles.length;
  const selectedCount = selectedFiles.size;
  const allSelected = totalIgnoredCount > 0 && selectedCount === totalIgnoredCount;
  const hasSelectedSecretFile = ignoredFiles.some(
    (file) => file.secretGuardMatched && selectedFiles.has(file.path),
  );
  const running = phase.kind === "running";

  const canSubmit =
    !running &&
    inspectState.kind === "ready" &&
    activeProject !== undefined &&
    activeDestination !== undefined &&
    activeDestination.connected &&
    activeDestination.actsAsHostPerson &&
    resolvedRemoteUrl !== undefined &&
    destinationPath.trim().length > 0;

  function toggleFile(path: string, checked: boolean): void {
    setSelectedFiles((current) => {
      const next = new Set(current);
      if (checked) next.add(path);
      else next.delete(path);
      return next;
    });
  }

  function toggleAllFiles(): void {
    if (allSelected) {
      setSelectedFiles(new Set());
      return;
    }
    setSelectedFiles(new Set(ignoredFiles.map((file) => file.path)));
  }

  async function handleCancelRun(): Promise<void> {
    const active = activeRunTargetRef.current;
    runAbortRef.current?.abort();
    if (active !== undefined) {
      await active.client.cancelClone({ operationId: active.operationId }).catch(() => undefined);
    }
    activeRunTargetRef.current = undefined;
    setPhase({ kind: "idle" });
  }

  function handleCloseRequest(): void {
    if (running) {
      void handleCancelRun().then(() => props.onClose());
      return;
    }
    props.onClose();
  }

  async function handleSubmit(): Promise<void> {
    if (
      !canSubmit ||
      activeProject === undefined ||
      activeDestination === undefined ||
      resolvedSourceClient === undefined
    ) {
      return;
    }
    const destinationClient = resolveDestinationClient(activeDestination);
    if (destinationClient === undefined || resolvedRemoteUrl === undefined) return;

    const controller = new AbortController();
    runAbortRef.current = controller;
    const operationId = decodeRepositoryBootstrapOperationId(globalThis.crypto.randomUUID());
    activeRunTargetRef.current = { client: destinationClient, operationId };

    const targetFolder = destinationPath.trim();
    const projectName = inspectData?.repositoryName ?? activeProject.name;
    const tickedPaths = ignoredFiles
      .filter((file) => selectedFiles.has(file.path))
      .map((file) => file.path);

    setPhase({
      kind: "running",
      stage: "cloning",
      operationId,
      detail: `Starting git clone on ${activeDestination.displayName}…`,
    });

    try {
      const started = await destinationClient.startClone(
        {
          operationId,
          remoteUrl: resolvedRemoteUrl,
          transport,
          destinationPath: targetFolder,
          projectName,
        },
        controller.signal,
      );

      let currentOp = started.operation;
      while (currentOp.state === "cloning") {
        if (controller.signal.aborted) {
          setPhase({ kind: "idle" });
          return;
        }
        setPhase({
          kind: "running",
          stage: "cloning",
          operationId,
          detail:
            currentOp.progressMessage ??
            `Cloning ${projectName} onto ${activeDestination.displayName}…`,
        });
        await sleepOrAbort(CLONE_POLL_INTERVAL_MS, controller.signal);
        if (controller.signal.aborted) {
          setPhase({ kind: "idle" });
          return;
        }
        const polled = await destinationClient.cloneStatus({ operationId }, controller.signal);
        currentOp = polled.operation;
      }

      if (currentOp.state === "cancelled") {
        setPhase({ kind: "idle" });
        return;
      }
      if (currentOp.state === "failed") {
        setPhase({
          kind: "failed",
          code: currentOp.code,
          message: currentOp.message,
        });
        return;
      }

      // Bind the newly cloned folder as a Code Project on the receiving computer.
      setPhase({
        kind: "running",
        stage: "binding",
        operationId,
        detail: `Binding ${currentOp.projectName} on ${activeDestination.displayName}…`,
      });
      const newProjectId = decodeProjectId(globalThis.crypto.randomUUID());
      const created = await activeDestination.projectClient.executeProject({
        kind: "create-code-project",
        projectId: newProjectId,
        expectedVersion: Schema.decodeUnknownSync(AggregateVersion)(0),
        name: currentOp.projectName,
        receiptId: currentOp.receiptId,
        hostId: LOCAL_HOST_ID,
      });
      if (created.kind !== "code-project-created") {
        setPhase({
          kind: "failed",
          code: "unavailable",
          message: `Cloned the repository, but ${activeDestination.displayName} could not bind it as a Code Project.`,
        });
        return;
      }

      const completedResult: AddRepositoryToComputerCompleted = {
        destinationHostId: activeDestination.hostId,
        projectId: created.project.id,
        projectName: created.project.name,
      };

      // Copy only explicitly ticked ignored files after clone + bind succeed.
      if (tickedPaths.length > 0) {
        const landedAll: string[] = [];
        const failedAll: RepositoryBootstrapLandFileFailure[] = [];
        let batch: RepositoryBootstrapFilePayload[] = [];
        let batchBytes = 0;

        const flushBatch = async () => {
          if (batch.length === 0) return;
          const sending = batch;
          batch = [];
          batchBytes = 0;
          try {
            const outcome = await destinationClient.landFiles(
              { operationId, files: sending },
              controller.signal,
            );
            landedAll.push(...outcome.landed);
            failedAll.push(...outcome.failed);
          } catch (error) {
            const message =
              error instanceof Error ? error.message : "Could not copy files to destination.";
            for (const file of sending) {
              failedAll.push({
                relativePath: file.relativePath,
                reason: "write-failed",
                message,
              });
            }
          }
        };

        for (let index = 0; index < tickedPaths.length; index += 1) {
          const relativePath = tickedPaths[index];
          if (relativePath === undefined) continue;
          setPhase({
            kind: "running",
            stage: "copying",
            operationId,
            detail: `Copying ignored file ${String(index + 1)} of ${String(tickedPaths.length)}: ${relativePath}`,
          });
          try {
            const read = await resolvedSourceClient.readIgnoredFile(
              { projectId: activeProject.id, relativePath },
              controller.signal,
            );
            if (batch.length > 0 && batchBytes + read.bytes > LAND_BATCH_MAX_RAW_BYTES) {
              await flushBatch();
            }
            batch.push(read);
            batchBytes += read.bytes;
          } catch (error) {
            failedAll.push({
              relativePath,
              reason: "write-failed",
              message: error instanceof Error ? error.message : "Could not read file from source.",
            });
          }
        }
        await flushBatch();

        if (failedAll.length > 0) {
          setPhase({
            kind: "partial-copy",
            completed: completedResult,
            landedCount: landedAll.length,
            failed: failedAll,
          });
          return;
        }
      }

      setPhase({ kind: "idle" });
      props.onCompleted?.(completedResult);
      props.onClose();
    } catch (error: unknown) {
      if (controller.signal.aborted) {
        setPhase({ kind: "idle" });
        return;
      }
      if (error instanceof RepositoryBootstrapClientFailure) {
        setPhase({ kind: "failed", code: error.code, message: error.message });
      } else {
        setPhase({
          kind: "failed",
          code: "clone-failed",
          message:
            error instanceof Error
              ? error.message
              : "Could not clone the repository onto the destination computer.",
        });
      }
    } finally {
      activeRunTargetRef.current = undefined;
      runAbortRef.current = undefined;
    }
  }

  const alternateTransport: RepositoryCloneTransport | undefined =
    transport === "ssh" && httpsUrl !== undefined
      ? "https"
      : transport === "https" && sshUrl !== undefined
        ? "ssh"
        : undefined;

  const transferFilesLabel =
    selectedCount === 0
      ? "no files"
      : selectedCount === 1
        ? "1 file"
        : `${String(selectedCount)} files`;

  const sourcePathDisplay =
    inspectData !== undefined
      ? homeRelativePath(inspectData.sourcePath)
      : activeProject !== undefined
        ? homeRelativePath(activeProject.binding.canonicalRoot)
        : "";

  return (
    <OctantDialog
      className="repo-bootstrap-dialog"
      label="Add to another computer"
      labelledBy={titleId}
      onClose={handleCloseRequest}
      open={props.open}
    >
      <header className="repo-bootstrap-dialog__header">
        <div>
          <h2 className="repo-bootstrap-dialog__title" id={titleId}>
            Add to another computer
          </h2>
          <p className="repo-bootstrap-dialog__subtitle">
            Clone this repository and optionally copy local gitignored files.
          </p>
        </div>
        <OctantButton
          aria-label="Close"
          onClick={handleCloseRequest}
          size="icon-sm"
          type="button"
          variant="ghost"
        >
          <X aria-hidden="true" size={16} />
        </OctantButton>
      </header>

      {eligibleDestinations.length === 0 ? (
        <OctantAlert tone="warning">
          No eligible paired computer is connected. Pair with a computer as its own person before
          cloning repositories there.
        </OctantAlert>
      ) : selectableProjects.length === 0 ? (
        <OctantAlert tone="warning">
          No local Code Projects on {props.sourceHostName} are available to clone yet.
        </OctantAlert>
      ) : (
        <>
          {props.project === undefined && selectableProjects.length > 1 ? (
            <OctantField>
              <OctantFieldLabel>Repository</OctantFieldLabel>
              <OctantSelectField
                aria-label="Source repository"
                disabled={running}
                onValueChange={setSelectedProjectId}
                options={selectableProjects.map((item) => ({
                  id: String(item.id),
                  label: item.name,
                }))}
                value={activeProject === undefined ? "" : String(activeProject.id)}
              />
            </OctantField>
          ) : null}

          {eligibleDestinations.length > 1 ? (
            <OctantField>
              <OctantFieldLabel>Destination computer</OctantFieldLabel>
              <OctantSelectField
                aria-label="Destination computer"
                disabled={running}
                onValueChange={setSelectedHostId}
                options={eligibleDestinations.map((item) => ({
                  id: String(item.hostId),
                  label: item.displayName,
                }))}
                value={activeDestination === undefined ? "" : String(activeDestination.hostId)}
              />
            </OctantField>
          ) : null}

          <div className="repo-bootstrap-dialog__flow" data-testid="repo-bootstrap-summary">
            <div className="repo-bootstrap-dialog__endpoint">
              <span className="repo-bootstrap-dialog__endpoint-host">{props.sourceHostName}</span>
              <span className="repo-bootstrap-dialog__endpoint-path" title={sourcePathDisplay}>
                {sourcePathDisplay}
              </span>
            </div>
            <div className="repo-bootstrap-dialog__transfer-pill">
              <strong>git clone</strong>
              <span>{transferFilesLabel}</span>
            </div>
            <div className="repo-bootstrap-dialog__endpoint repo-bootstrap-dialog__endpoint--target">
              <span className="repo-bootstrap-dialog__endpoint-host">
                {activeDestination?.displayName ?? "Destination"}
              </span>
              <span
                className="repo-bootstrap-dialog__endpoint-path"
                title={destinationPath || "~/<repo>"}
              >
                {destinationPath || "~/<repo>"}
              </span>
            </div>
          </div>

          {inspectState.kind === "loading" ? (
            <div className="repo-bootstrap-dialog__empty" role="status">
              Inspecting repository remote and ignored files…
            </div>
          ) : inspectState.kind === "error" ? (
            <OctantAlert tone="danger">{inspectState.message}</OctantAlert>
          ) : (
            <>
              <div className="repo-bootstrap-dialog__section">
                <div className="repo-bootstrap-dialog__section-row">
                  <span className="repo-bootstrap-dialog__label">Clone transport</span>
                  <OctantToggleGroup<RepositoryCloneTransport>
                    aria-label="Clone transport"
                    disabled={running}
                    onValueChange={(values) => {
                      const next = values[0];
                      if (next === "ssh" || next === "https") setTransport(next);
                    }}
                    value={[transport]}
                  >
                    <OctantToggleGroupItem disabled={sshUrl === undefined || running} value="ssh">
                      SSH
                    </OctantToggleGroupItem>
                    <OctantToggleGroupItem
                      disabled={httpsUrl === undefined || running}
                      value="https"
                    >
                      HTTPS
                    </OctantToggleGroupItem>
                  </OctantToggleGroup>
                </div>
                {resolvedRemoteUrl !== undefined ? (
                  <div
                    className="repo-bootstrap-dialog__url-preview"
                    data-testid="repo-bootstrap-remote-preview"
                  >
                    {resolvedRemoteUrl}
                  </div>
                ) : (
                  <OctantAlert tone="warning">
                    {inspectData?.remotes.unavailableReason ??
                      "This repository does not have a supported SSH or HTTPS origin remote."}
                  </OctantAlert>
                )}
              </div>

              <OctantField>
                <OctantFieldLabel htmlFor={folderInputId}>
                  Folder on {activeDestination?.displayName ?? "destination"}
                </OctantFieldLabel>
                <OctantInput
                  disabled={running}
                  id={folderInputId}
                  onChange={(event) => setDestinationPath(event.target.value)}
                  placeholder={inspectData?.defaultDestinationPath ?? "~/repository"}
                  value={destinationPath}
                />
              </OctantField>

              <div className="repo-bootstrap-dialog__section">
                <div className="repo-bootstrap-dialog__section-row">
                  <span className="repo-bootstrap-dialog__label">Copy ignored files</span>
                  <div className="repo-bootstrap-dialog__files-controls">
                    <span
                      className="repo-bootstrap-dialog__count"
                      data-testid="repo-bootstrap-file-count"
                    >
                      {selectedCount} of {totalIgnoredCount}
                    </span>
                    <OctantButton
                      disabled={totalIgnoredCount === 0 || running}
                      onClick={toggleAllFiles}
                      size="xs"
                      type="button"
                      variant="ghost"
                    >
                      {allSelected ? "None" : "All"}
                    </OctantButton>
                  </div>
                </div>

                <div className="repo-bootstrap-dialog__file-list">
                  {totalIgnoredCount === 0 ? (
                    <div className="repo-bootstrap-dialog__empty">
                      No local ignored files to copy.
                    </div>
                  ) : (
                    ignoredFiles.map((file) => {
                      const checked = selectedFiles.has(file.path);
                      return (
                        <label className="repo-bootstrap-dialog__file-row" key={file.path}>
                          <OctantCheckbox
                            aria-label={file.path}
                            checked={checked}
                            disabled={running}
                            onChange={(event) => toggleFile(file.path, event.currentTarget.checked)}
                          />
                          <span className="repo-bootstrap-dialog__file-path" title={file.path}>
                            {file.path}
                          </span>
                          {file.secretGuardMatched ? (
                            <span
                              className="repo-bootstrap-dialog__secret-badge"
                              title="Matches secret guard patterns; sent directly to the destination computer over your paired session"
                            >
                              Secret
                            </span>
                          ) : (
                            <span />
                          )}
                          <span className="repo-bootstrap-dialog__file-size">
                            {formatBytes(file.bytes)}
                          </span>
                        </label>
                      );
                    })
                  )}
                </div>

                {hasSelectedSecretFile ? (
                  <OctantAlert tone="warning">
                    Files marked Secret may contain local credentials. Only the exact files you
                    ticked are sent directly to{" "}
                    {activeDestination?.displayName ?? "the destination"}.
                  </OctantAlert>
                ) : null}

                {inspectData?.truncated === true ? (
                  <p className="repo-bootstrap-dialog__helper">
                    Some files were left out (
                    {inspectData.omittedOversizedCount > 0
                      ? `${String(inspectData.omittedOversizedCount)} larger than ${formatBytes(inspectData.caps.maxFileBytes)}`
                      : ""}
                    {inspectData.omittedOversizedCount > 0 && inspectData.omittedCount > 0
                      ? ", "
                      : ""}
                    {inspectData.omittedCount > 0
                      ? `${String(inspectData.omittedCount)} past the ${String(inspectData.caps.maxFiles)}-file limit`
                      : ""}
                    ).
                  </p>
                ) : null}

                <p className="repo-bootstrap-dialog__helper">
                  Files are copied after git clone finishes. Whole ignored directories such as{" "}
                  <code>node_modules</code> are left out.
                </p>
              </div>
            </>
          )}

          {phase.kind === "running" ? (
            <div className="repo-bootstrap-dialog__progress" role="status">
              <strong>
                {phase.stage === "cloning"
                  ? "Cloning repository…"
                  : phase.stage === "binding"
                    ? "Binding Code Project…"
                    : "Copying selected files…"}
              </strong>
              <span className="repo-bootstrap-dialog__progress-detail">{phase.detail}</span>
            </div>
          ) : null}

          {phase.kind === "failed" ? (
            <OctantAlert tone="danger">
              <div>{phase.message}</div>
              {(phase.code === "auth-failed" || phase.code === "host-key-unverified") &&
              alternateTransport !== undefined ? (
                <div style={{ marginTop: 8 }}>
                  <OctantButton
                    onClick={() => {
                      setTransport(alternateTransport);
                      setPhase({ kind: "idle" });
                    }}
                    size="xs"
                    type="button"
                    variant="secondary"
                  >
                    Switch to {alternateTransport.toUpperCase()}
                  </OctantButton>
                </div>
              ) : null}
            </OctantAlert>
          ) : null}

          {phase.kind === "partial-copy" ? (
            <OctantAlert tone="warning">
              <div>
                <strong>
                  Cloned and added {phase.completed.projectName} on{" "}
                  {activeDestination?.displayName ?? "destination"}
                </strong>
                , but {phase.failed.length} selected{" "}
                {phase.failed.length === 1 ? "file was" : "files were"} not copied:
              </div>
              <ul className="repo-bootstrap-dialog__failed-list">
                {phase.failed.map((item) => (
                  <li key={item.relativePath}>
                    <code>{item.relativePath}</code> — {item.message}
                  </li>
                ))}
              </ul>
            </OctantAlert>
          ) : null}

          <footer className="repo-bootstrap-dialog__actions">
            {phase.kind === "partial-copy" ? (
              <OctantButton
                onClick={() => {
                  props.onCompleted?.(phase.completed);
                  props.onClose();
                }}
                size="sm"
                type="button"
                variant="solid"
              >
                Open on {activeDestination?.displayName ?? "destination"}
              </OctantButton>
            ) : (
              <>
                <OctantButton onClick={handleCloseRequest} size="sm" type="button" variant="ghost">
                  {running ? "Cancel clone" : "Cancel"}
                </OctantButton>
                <OctantButton
                  disabled={!canSubmit}
                  onClick={() => void handleSubmit()}
                  size="sm"
                  type="button"
                  variant="solid"
                >
                  {running
                    ? "Cloning…"
                    : `Clone to ${activeDestination?.displayName ?? "computer"}`}
                </OctantButton>
              </>
            )}
          </footer>
        </>
      )}
    </OctantDialog>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function sleepOrAbort(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
