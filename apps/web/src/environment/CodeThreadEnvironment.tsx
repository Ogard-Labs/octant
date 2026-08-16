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
import type { ReactNode } from "react";
import { EnvironmentGitGroup } from "./EnvironmentGitGroup";
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
 * panel presentation (floating/pinned/hidden) follows the per-tab shell
 * presentation state.
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
  // Scan only while the section can actually be seen: a hidden panel must not
  // ask the host to enumerate listeners on a timer.
  const localServersVisible =
    resolved.presentation !== "hidden" && localServersSection?.available === true;
  const localServers = useLocalServersController({
    enabled: localServersVisible,
    ...(props.localServerClient === undefined ? {} : { client: props.localServerClient }),
    threadId: props.tab.threadId,
    ...(props.project === undefined ? {} : { projectId: props.project.id }),
    ...(props.serverUrl === undefined ? {} : { serverUrl: props.serverUrl }),
    ...(props.windowCapability === undefined ? {} : { windowCapability: props.windowCapability }),
  });

  return (
    <div className={`code-thread-environment code-thread-environment--${resolved.presentation}`}>
      <div className="code-thread-environment__content">{props.children}</div>
      <ThreadEnvironmentPanel
        identity={projection.identity}
        mode="code"
        presentation={props.presentation}
        tabId={props.tab.id}
        onChangePresentation={props.onChangePresentation}
      >
        {controller.observation?.workingDirectory === undefined ||
        controller.observation.threadVersion === undefined ||
        props.onExecute === undefined ? null : (
          <WorkingDirectoryControl
            value={controller.observation.workingDirectory}
            onApply={async (workingDirectory) => {
              const result = await props.onExecute?.({
                kind: "change-code-thread-working-directory",
                threadId: props.tab.threadId,
                expectedVersion: controller.observation!.threadVersion!,
                workingDirectory,
              });
              if (result === undefined || !("kind" in result) || result.kind !== "thread-updated") {
                throw new Error("Code working directory was not updated.");
              }
              await controller.refresh();
            }}
          />
        )}
        <EnvironmentGitGroup
          {...(controller.errorMessage === undefined
            ? {}
            : { errorMessage: controller.errorMessage })}
          {...(controller.observation === undefined ? {} : { observation: controller.observation })}
          status={controller.status}
        />
        <section aria-label="Local servers" className="code-thread-environment__local-servers">
          <h2 className="code-thread-environment__section-heading">Local servers</h2>
          <LocalServersGroup
            controller={localServers}
            {...(props.onOpenLocalServer === undefined
              ? {}
              : { onOpenTarget: props.onOpenLocalServer })}
            {...(props.onCopyLocalServerUrl === undefined
              ? {}
              : { onCopyUrl: props.onCopyLocalServerUrl })}
            {...(localServersVisible
              ? {}
              : {
                  unavailableReason:
                    localServersSection?.unavailableReason ??
                    "Open a repository Project to view local servers.",
                })}
          />
        </section>
      </ThreadEnvironmentPanel>
    </div>
  );
}
