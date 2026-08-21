import type { ProjectClient } from "@octant/client-runtime/project-client";
import type { LocalServerClient } from "@octant/client-runtime";
import type {
  CodeCommand,
  CodeCommandResult,
  EnvironmentPresentationState,
  LocalServerOpenTarget,
  ProjectSummary,
  WorkspaceTab,
} from "@octant/contracts";
import { deriveCodeEnvironmentProjection } from "@octant/domain/shell-policy";
import { useState, type ReactNode } from "react";
import { EnvironmentGitGroup } from "./EnvironmentGitGroup";
import { EnvironmentGroup } from "./EnvironmentGroup";
import { resolveTabPresentation } from "./EnvironmentPresentationModel";
import { LocalServersGroup } from "./LocalServersGroup";
import { ThreadEnvironmentPanel } from "./ThreadEnvironmentPanel";
import { useCodeEnvironmentController } from "./useCodeEnvironmentController";
import { useLocalServersController } from "./useLocalServersController";
import { WorkingDirectoryControl } from "./WorkingDirectoryControl";

type CodeThreadWorkspaceTab = Extract<WorkspaceTab, { readonly mode: "code" }>;

export interface CodeThreadEnvironmentProps {
  readonly tab: CodeThreadWorkspaceTab;
  readonly presentation: EnvironmentPresentationState;
  readonly onChangePresentation: (next: EnvironmentPresentationState) => void;
  readonly project?: ProjectSummary | undefined;
  readonly projectClient?: ProjectClient | undefined;
  readonly serverUrl?: string;
  readonly windowCapability?: string;
  readonly children: ReactNode;
  /** Opens the thread's Changes (diff) surface. Absent hides the control. */
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
}

/**
 * Mounts the thread-scoped Environment panel inside a Code thread tab, backed
 * by the authoritative {@link CodeEnvironmentObservation} for the tab's
 * Project. The compact identity and capability-valid Code sections are derived
 * from the real observation, and the Git facts render in the panel body. The
 * panel presentation (floating/hidden) follows the per-tab shell presentation
 * state.
 *
 * The panel holds what the *environment* answers for — what the checkout has
 * changed, what is listening, where work happens. The thread's own working
 * surfaces (Files, Plan, Publish, Agents) are the dock's Thread panel, which
 * has room for them; stacked here they turned a glanceable float into a list
 * of disclosures.
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
  const resolved = resolveTabPresentation(props.presentation, "code", props.tab.id);
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
  const [localServersOpen, setLocalServersOpen] = useState(false);
  // Scan only while the section can actually be seen: a hidden panel or a
  // collapsed group must not ask the host to enumerate listeners on a timer.
  const localServersAvailable = resolved !== "hidden" && localServersSection?.available === true;
  const localServersVisible = localServersAvailable && localServersOpen;
  const localServers = useLocalServersController({
    enabled: localServersVisible,
    ...(props.localServerClient === undefined ? {} : { client: props.localServerClient }),
    threadId: props.tab.threadId,
    ...(props.project === undefined ? {} : { projectId: props.project.id }),
    ...(props.serverUrl === undefined ? {} : { serverUrl: props.serverUrl }),
    ...(props.windowCapability === undefined ? {} : { windowCapability: props.windowCapability }),
  });

  return (
    <div className={`code-thread-environment code-thread-environment--${resolved}`}>
      <div className="code-thread-environment__content">{props.children}</div>
      <ThreadEnvironmentPanel
        identity={projection.identity}
        mode="code"
        presentation={props.presentation}
        tabId={props.tab.id}
        onChangePresentation={props.onChangePresentation}
      >
        <EnvironmentGroup
          defaultOpen
          summary={
            controller.observation?.status === "ready"
              ? controller.observation.changes === "dirty"
                ? "Dirty"
                : "Clean"
              : undefined
          }
          title="Changes"
        >
          <EnvironmentGitGroup
            {...(freshThreadAction === undefined ? {} : { action: freshThreadAction })}
            {...(controller.errorMessage === undefined
              ? {}
              : { errorMessage: controller.errorMessage })}
            {...(controller.observation === undefined
              ? {}
              : { observation: controller.observation })}
            status={controller.status}
          />
          {props.onOpenChanges === undefined ||
          controller.observation?.status !== "ready" ? null : (
            <button
              className="environment-group__action window-no-drag"
              onClick={props.onOpenChanges}
              type="button"
            >
              View diff
            </button>
          )}
        </EnvironmentGroup>
        <EnvironmentGroup
          onOpenChange={setLocalServersOpen}
          {...(localServers.snapshot === undefined
            ? {}
            : {
                summary: `${
                  localServers.snapshot.currentCheckout.length + localServers.snapshot.other.length
                } running`,
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
        {controller.observation?.workingDirectory === undefined ||
        controller.observation.threadVersion === undefined ||
        props.onExecute === undefined ? null : (
          <EnvironmentGroup title="Working folder">
            <WorkingDirectoryControl
              value={controller.observation.workingDirectory}
              onApply={async (workingDirectory) => {
                const result = await props.onExecute?.({
                  kind: "change-code-thread-working-directory",
                  threadId: props.tab.threadId,
                  expectedVersion: controller.observation!.threadVersion!,
                  workingDirectory,
                });
                if (
                  result === undefined ||
                  !("kind" in result) ||
                  result.kind !== "thread-updated"
                ) {
                  throw new Error("Code working directory was not updated.");
                }
                await controller.refresh();
              }}
            />
          </EnvironmentGroup>
        )}
      </ThreadEnvironmentPanel>
    </div>
  );
}
