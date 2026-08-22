import type { ProjectClient } from "@octant/client-runtime/project-client";
import type { LocalServerClient } from "@octant/client-runtime";
import type { GithubClient } from "@octant/client-runtime/github-client";
import type {
  CodeCommand,
  CodeCommandResult,
  LocalServerOpenTarget,
  ProjectSummary,
  WorkspaceTab,
} from "@octant/contracts";
import { deriveCodeEnvironmentProjection } from "@octant/domain/shell-policy";
import { useState, type ReactNode } from "react";
import { EnvironmentGitGroup } from "./EnvironmentGitGroup";
import { EnvironmentGroup } from "./EnvironmentGroup";
import { EnvironmentPullRequests } from "./EnvironmentPullRequests";
import { countGroupedLocalServerListeners } from "./localServerGroups";
import { LocalServersGroup } from "./LocalServersGroup";
import { ThreadEnvironmentPanel } from "./ThreadEnvironmentPanel";
import { useCodeEnvironmentController } from "./useCodeEnvironmentController";
import { useLocalServersController } from "./useLocalServersController";
import { ChangeWorkingFolder } from "./WorkingDirectoryControl";

type CodeThreadWorkspaceTab = Extract<WorkspaceTab, { readonly mode: "code" }>;

export interface CodeThreadEnvironmentProps {
  readonly tab: CodeThreadWorkspaceTab;
  readonly active?: boolean;
  readonly project?: ProjectSummary | undefined;
  readonly projectClient?: ProjectClient | undefined;
  readonly serverUrl?: string;
  readonly windowCapability?: string;
  readonly children: ReactNode;
  /** Opens Review beside this thread. Absent hides the control. */
  readonly onOpenChanges?: () => void;
  /**
   * Starts a fresh thread in this Project. Offered only when the checkout is
   * unusable: a thread created against an older binding revision can never
   * observe its own checkout again, so a new thread is the way forward.
   */
  readonly onNewThreadInProject?: (projectId: ProjectSummary["id"]) => void;
  readonly onExecute?: (
    command: CodeCommand,
    signal?: AbortSignal,
  ) => Promise<CodeCommandResult | undefined>;
  /**
   * Creates a new host-owned Browser tab for exactly one local origin.
   * Absent means the shell has nowhere to put the tab, so the Open control is
   * hidden entirely rather than rendered dead.
   */
  readonly onOpenLocalServer?: (target: LocalServerOpenTarget) => void | Promise<void>;
  /** Writes a local URL to the host clipboard. Absent hides the Copy control. */
  readonly onCopyLocalServerUrl?: (url: string) => void | Promise<void>;
  /** Injected in tests; otherwise built from the server URL and capability. */
  readonly localServerClient?: LocalServerClient;
  readonly githubClient?: GithubClient;
  readonly pullRequestRepository?: string;
}

/**
 * Compact Code Environment: a truthful header summary and a transient
 * disclosure for checkout facts, local servers, and the working folder.
 */
export function CodeThreadEnvironment(props: CodeThreadEnvironmentProps) {
  const controller = useCodeEnvironmentController({
    ...(props.projectClient === undefined ? {} : { client: props.projectClient }),
    enabled: props.project !== undefined,
    project: props.project,
    threadId: props.tab.threadId,
    ...(props.serverUrl === undefined ? {} : { serverUrl: props.serverUrl }),
    ...(props.windowCapability === undefined ? {} : { windowCapability: props.windowCapability }),
  });
  const projectName = props.project?.name ?? "Code";
  const projection = deriveCodeEnvironmentProjection({
    observation: controller.observation,
    projectName,
    controllerStatus: controller.status,
  });
  const localServersSection = projection.sections.find((section) => section.id === "local-servers");
  const project = props.project;
  const onNewThreadInProject = props.onNewThreadInProject;
  const checkoutUnusable =
    controller.status === "error" ||
    controller.observation?.status === "unavailable" ||
    controller.observation?.status === "failed";
  const freshThreadAction =
    !checkoutUnusable || project === undefined || onNewThreadInProject === undefined
      ? undefined
      : { label: "New thread in this Project", onClick: () => onNewThreadInProject(project.id) };
  const observed = controller.observation;
  const readyObservation = observed?.status === "ready" ? observed : undefined;
  const [disclosureOpen, setDisclosureOpen] = useState(false);
  const localServersAvailable = localServersSection?.available === true;
  const localServers = useLocalServersController({
    enabled: localServersAvailable,
    poll: localServersAvailable && disclosureOpen,
    ...(props.localServerClient === undefined ? {} : { client: props.localServerClient }),
    threadId: props.tab.threadId,
    ...(props.project === undefined ? {} : { projectId: props.project.id }),
    ...(props.serverUrl === undefined ? {} : { serverUrl: props.serverUrl }),
    ...(props.windowCapability === undefined ? {} : { windowCapability: props.windowCapability }),
  });
  const runningServerCount =
    localServers.snapshot === undefined
      ? undefined
      : countGroupedLocalServerListeners(localServers.snapshot);
  const workingDirectory = readyObservation?.workingDirectory;
  const threadVersion = readyObservation?.threadVersion;

  return (
    <div className="code-thread-environment">
      <ThreadEnvironmentPanel
        {...(props.active === undefined ? {} : { active: props.active })}
        onOpenChange={setDisclosureOpen}
        open={disclosureOpen}
        summary={{
          identity: projection.identity,
          ...(readyObservation === undefined
            ? {}
            : {
                branch:
                  readyObservation.branch.kind === "named"
                    ? readyObservation.branch.name
                    : `Detached ${readyObservation.branch.oid.slice(0, 7)}`,
                changes: readyObservation.changes,
              }),
          ...(workingDirectory === undefined ? {} : { workingLocation: String(workingDirectory) }),
          ...(runningServerCount === undefined ? {} : { runningServerCount }),
        }}
      >
        <EnvironmentGitGroup
          {...(freshThreadAction === undefined ? {} : { action: freshThreadAction })}
          {...(controller.errorMessage === undefined
            ? {}
            : { errorMessage: controller.errorMessage })}
          {...(controller.observation === undefined ? {} : { observation: controller.observation })}
          status={controller.status}
        />
        {props.onOpenChanges === undefined || readyObservation === undefined ? null : (
          <button
            className="environment-group__action window-no-drag"
            onClick={() => {
              setDisclosureOpen(false);
              props.onOpenChanges?.();
            }}
            type="button"
          >
            View changes
          </button>
        )}
        <EnvironmentGroup
          defaultOpen
          {...(localServers.snapshot === undefined
            ? {}
            : {
                summary: `${String(countGroupedLocalServerListeners(localServers.snapshot))} running`,
              })}
          title="Local servers"
        >
          <LocalServersGroup
            controller={localServers}
            {...(props.onOpenLocalServer === undefined
              ? {}
              : { onOpenTarget: props.onOpenLocalServer })}
            {...(props.onCopyLocalServerUrl === undefined
              ? {}
              : { onCopyUrl: props.onCopyLocalServerUrl })}
            {...(localServersAvailable
              ? {}
              : {
                  unavailableReason:
                    localServersSection?.unavailableReason ??
                    "Open a repository Project to view local servers.",
                })}
          />
        </EnvironmentGroup>
        {props.githubClient === undefined || props.pullRequestRepository === undefined ? null : (
          <EnvironmentGroup defaultOpen title="Pull requests">
            <EnvironmentPullRequests
              client={props.githubClient}
              enabled={disclosureOpen}
              repository={props.pullRequestRepository}
            />
          </EnvironmentGroup>
        )}
        {workingDirectory === undefined ||
        threadVersion === undefined ||
        props.onExecute === undefined ? null : (
          <ChangeWorkingFolder
            value={workingDirectory}
            onApply={async (nextWorkingDirectory) => {
              const result = await props.onExecute?.({
                kind: "change-code-thread-working-directory",
                threadId: props.tab.threadId,
                expectedVersion: threadVersion,
                workingDirectory: nextWorkingDirectory,
              });
              if (result === undefined || !("kind" in result) || result.kind !== "thread-updated") {
                throw new Error("Code working directory was not updated.");
              }
              await controller.refresh();
            }}
          />
        )}
      </ThreadEnvironmentPanel>
      <div className="code-thread-environment__content">{props.children}</div>
    </div>
  );
}
