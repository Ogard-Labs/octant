import { decodeCodeThreadId } from "@octant/contracts/code";
import { decodeWorkThreadId, type CodeOperationId } from "@octant/contracts";
import { memo, Suspense, useCallback, useMemo, type ReactNode } from "react";
import type { createLaunchedShellClients } from "./createLaunchedShellClients";
import type { useNavigatorAssistant } from "../navigator/useNavigatorAssistant";
import type { useProjectController } from "../projects/useProjectController";
import {
  ZenCanvasCard,
  ZenProjectResearchDock,
  ZenProjectTerminalCard,
  ZenResearchDock,
  ZenSurface,
  ZenTerminalCard,
} from "../shell/deferredSurfaces";
import type { OctantHostBridge } from "../shell/hostBridge";
import type { useShellController } from "../shell/useShellController";
import type { useSidebarBackgroundFetcher } from "../shell/useShellPresentation";
import type { CodeThread } from "@octant/contracts/code";
import type { ZenSourceContext } from "@octant/contracts/zen";
import type { resolveAppBackground } from "@octant/domain/theme-policy";
import { resolveZenLiveThreadCard, type ZenLiveThreadClients } from "../zen/ZenLiveThreadCards";
import {
  resolveZenProjectTerminalTarget,
  resolveZenTerminalPinTarget,
} from "../zen/zenThreadActions";
import { ZenRoot } from "../zen/ZenRoot";
import type { useZenController } from "../zen/useZenController";
import type { ShellActions } from "./shellActions";

export interface ZenContainerProps {
  readonly actions: Pick<
    ShellActions,
    "addZenBrowser" | "addZenProjectTerminal" | "addZenTerminal" | "openSettings"
  >;
  readonly allProjects: ReturnType<typeof useProjectController>["allProjects"];
  readonly appBackground: ReturnType<typeof resolveAppBackground> | undefined;
  readonly appBackgroundFetcher: ReturnType<typeof useSidebarBackgroundFetcher>;
  readonly children: ReactNode;
  readonly clients: ReturnType<typeof createLaunchedShellClients>;
  readonly codeThreads: ReadonlyArray<CodeThread> | undefined;
  readonly createCodeOperationId: () => CodeOperationId;
  readonly hostBridge?: OctantHostBridge;
  readonly navigatorAssistant: ReturnType<typeof useNavigatorAssistant>;
  readonly serverUrl: string;
  readonly windowCapability: string;
  readonly workspace: NonNullable<ReturnType<typeof useShellController>["workspace"]>;
  readonly zen: ReturnType<typeof useZenController>;
  readonly zenLiveThreadClients: ZenLiveThreadClients;
}

/**
 * Zen: the presentation aggregate drawn over the shell when it is active. The
 * shell (this container's children) stays mounted underneath; the surface and
 * its cards mount only while Zen is active, so an inactive Zen costs the shell
 * nothing per render.
 */
export const ZenContainer = memo(function ZenContainer(props: ZenContainerProps) {
  const { actions, allProjects, codeThreads, navigatorAssistant, workspace, zen } = props;
  const resolvedAppBackground = props.appBackground;
  const sidebarBackgroundFetcher = props.appBackgroundFetcher;
  const {
    browserAutomationClient,
    canvasClient,
    codeClient,
    projectBrowserClient,
    projectTerminalClient,
  } = props.clients;
  const { createCodeOperationId, serverUrl, windowCapability } = props;
  const zenLiveThreadClients = props.zenLiveThreadClients;

  // The Project a browser opens for: the one the active mode holds when that
  // is Work or Code, otherwise the window's Code Project, then its Work one.
  const zenProjectBrowserTarget = useMemo(() => {
    const modes: ReadonlyArray<"work" | "code"> =
      workspace.activeMode === "work" ? ["work", "code"] : ["code", "work"];
    for (const mode of modes) {
      const projectId = workspace.contextByMode[mode].projectId ?? undefined;
      if (projectId === undefined) continue;
      const project = allProjects.find(
        (candidate) =>
          String(candidate.id) === String(projectId) &&
          candidate.type === mode &&
          candidate.lifecycle === "active",
      );
      if (project !== undefined) return { projectId: project.id, name: project.name };
    }
    return undefined;
  }, [allProjects, workspace]);

  // Asked while the Add terminal menu renders, so it is a prop derived here
  // rather than an action: actions answer with the committed render, and a
  // thread the menu is drawing for must be judged by the same render.
  const canAddTerminal = useCallback(
    (sourceContext: ZenSourceContext): boolean =>
      resolveZenTerminalPinTarget(sourceContext, codeThreads ?? []) !== undefined,
    [codeThreads],
  );

  const zenProjectTerminalTarget = useMemo(
    () => resolveZenProjectTerminalTarget(workspace, allProjects),
    [allProjects, workspace],
  );

  return (
    <ZenRoot
      active={zen.active}
      onCycleSpace={(step) => void zen.cycleSpace(step)}
      onExit={zen.exitZen}
      onToggle={() => {
        if (zen.active) zen.exitZen();
        else void zen.enterZen();
      }}
      zen={
        zen.space === null ? (
          <div className="zen-surface zen-surface--loading" role="status">
            Opening Zen…
          </div>
        ) : (
          <Suspense
            fallback={
              <div className="zen-surface zen-surface--loading" role="status">
                Opening Zen…
              </div>
            }
          >
            <ZenSurface
              {...(resolvedAppBackground === undefined
                ? {}
                : { appBackground: resolvedAppBackground })}
              appBackgroundFetcher={sidebarBackgroundFetcher}
              assistant={zen.assistant}
              focusZone={zen.focusZone}
              renderTerminal={({ element, activity }) => {
                // The card acts under the thread that owns the shell, so its
                // posture is that thread's own. A thread this window can no
                // longer see is a card that opens nothing.
                const owner = codeThreads?.find(
                  (candidate) => String(candidate.id) === String(element.sourceContext.threadId),
                );
                if (owner === undefined) return undefined;
                return (
                  <Suspense fallback={null}>
                    <ZenTerminalCard
                      client={codeClient}
                      createOperationId={createCodeOperationId}
                      executionPolicy={owner.executionPolicy}
                      live={activity.activity === "live"}
                      scope={{ checkoutId: element.checkoutId, threadId: owner.id }}
                      terminalId={element.terminalId}
                    />
                  </Suspense>
                );
              }}
              renderCanvas={({ element }) => {
                // The card reads the same document a workspace tab reads, so it
                // needs the same client and no authority of its own. Without one
                // the card says it cannot read rather than showing nothing.
                if (canvasClient === undefined) return undefined;
                return (
                  <Suspense fallback={null}>
                    <ZenCanvasCard canvasId={element.canvasId} client={canvasClient} />
                  </Suspense>
                );
              }}
              renderResearchDock={({ dock }) => {
                if ("project" in dock) {
                  // A Project's own browser: the person's page, in a context
                  // no thread shares. The host decides whether this window
                  // still holds the Project each time the dock asks.
                  return (
                    <Suspense fallback={null}>
                      <ZenProjectResearchDock
                        client={projectBrowserClient}
                        dock={dock}
                        {...(props.hostBridge === undefined
                          ? {}
                          : { hostBridge: props.hostBridge })}
                        onCollapse={(collapsed) =>
                          void zen.dockResearch({
                            thread: null,
                            project: { projectId: dock.project.projectId },
                            width: dock.width,
                            collapsed,
                          })
                        }
                        onUndock={() => void zen.dockResearch({ thread: null })}
                      />
                    </Suspense>
                  );
                }
                // The dock shows the bound thread's own browsing context. Zen
                // holds no browser client of its own; it hands over the binding
                // and the shell's client, and the server decides what that
                // thread's context may reach.
                if (browserAutomationClient === undefined) return undefined;
                return (
                  <Suspense fallback={null}>
                    <ZenResearchDock
                      client={browserAutomationClient}
                      dock={dock}
                      {...(props.hostBridge === undefined ? {} : { hostBridge: props.hostBridge })}
                      serverUrl={serverUrl}
                      {...(windowCapability === undefined
                        ? {}
                        : { windowCapability: windowCapability })}
                      onCollapse={(collapsed) =>
                        void zen.dockResearch({
                          thread: {
                            threadId:
                              dock.sourceContext.threadKind === "code"
                                ? decodeCodeThreadId(String(dock.sourceContext.threadId))
                                : decodeWorkThreadId(String(dock.sourceContext.threadId)),
                            mode: dock.sourceContext.threadKind === "code" ? "code" : "work",
                          },
                          width: dock.width,
                          collapsed,
                        })
                      }
                      onUndock={() => void zen.dockResearch({ thread: null })}
                    />
                  </Suspense>
                );
              }}
              spacesBusy={zen.panelBusy}
              onAddSpace={(name) => void zen.addSpace(name)}
              onRemoveSpace={(spaceId) => void zen.removeSpace(spaceId)}
              onRenameSpace={(spaceId, name) => void zen.renameSpace(spaceId, name)}
              onShowSpace={(spaceId) => void zen.showSpace(spaceId)}
              {...(zen.backgroundObjectUrl === undefined
                ? {}
                : { backgroundImageUrl: zen.backgroundObjectUrl })}
              backgroundStatus={zen.backgroundStatus}
              assistantOpen={zen.assistantOpen}
              barCollapsed={zen.barCollapsed}
              {...(zen.message === undefined ? {} : { message: zen.message })}
              panelBusy={zen.panelBusy}
              threadEntries={zen.threadEntries}
              threadPickerOpen={zen.threadPickerOpen}
              threadQuery={zen.threadQuery}
              onAddTimer={(durationMs) => void zen.addTimer(durationMs)}
              onAddBrowser={actions.addZenBrowser}
              onLoadThreads={() => void zen.refreshThreads("")}
              {...(zenProjectTerminalTarget === undefined
                ? {}
                : { projectTerminalTarget: zenProjectTerminalTarget })}
              onAddProjectTerminal={(projectId) => void actions.addZenProjectTerminal(projectId)}
              {...(zenProjectBrowserTarget === undefined
                ? {}
                : { projectBrowserTarget: zenProjectBrowserTarget })}
              onAddProjectBrowser={(projectId) =>
                void zen.dockResearch({ thread: null, project: { projectId } })
              }
              renderProjectTerminal={({ element, activity }) => (
                <Suspense fallback={null}>
                  <ZenProjectTerminalCard
                    client={projectTerminalClient}
                    live={activity.activity === "live"}
                    projectId={element.projectId}
                    terminalId={element.terminalId}
                  />
                </Suspense>
              )}
              onAddTerminal={(sourceContext) => {
                void actions.addZenTerminal(sourceContext);
              }}
              canAddTerminal={canAddTerminal}
              onPinThread={(catalogRef) => void zen.pinThread(catalogRef)}
              onCloseAssistant={() => zen.setAssistantOpen(false)}
              onCloseThreadPicker={() => zen.setThreadPickerOpen(false)}
              renderLiveThread={(input) =>
                resolveZenLiveThreadCard({ ...input, clients: zenLiveThreadClients })
              }
              onConfirmRecipePreview={(action) => void zen.confirmRecipePreview(action)}
              onCreateReference={(url, label) =>
                void zen.createReference(url, label).catch(() => undefined)
              }
              onUploadBackground={(file) => void zen.uploadBackground(file).catch(() => undefined)}
              onCreateWidget={(kind) => void zen.createWidget(kind).catch(() => undefined)}
              onExit={zen.exitZen}
              onExpandBar={() => zen.setBarCollapsed(false)}
              onHideBar={() => zen.setBarCollapsed(true)}
              navigatorAssistant={navigatorAssistant}
              onAssistantTurn={() => zen.refreshAssistant()}
              onOpenAssistant={() => zen.openAssistant()}
              onOpenSettings={(target) => void actions.openSettings(target)}
              onOpenThreads={(query) => void zen.openThreads(query)}
              onAddChecklistItem={zen.addChecklistItem}
              onRemoveElement={(elementId) => void zen.removeElement(elementId)}
              onRemoveChecklistItem={zen.removeChecklistItem}
              onReorderChecklistItem={zen.reorderChecklistItem}
              onSaveNotes={zen.saveNotes}
              onTimerAction={(elementId, action, durationMs) =>
                void zen.timerAction(elementId, action, durationMs)
              }
              onRefreshTimers={() => void zen.refreshTimers()}
              onSetChecklistItemCompleted={zen.setChecklistItemCompleted}
              onUpdateAppearance={(appearance) => void zen.updateAppearance(appearance)}
              onUpdateElement={(element) => zen.updateElement(element)}
              onSetLayout={(layout) => zen.setLayout(layout)}
              onUpdateViewport={(viewport) => void zen.updateViewport(viewport)}
              space={zen.space}
            />
          </Suspense>
        )
      }
    >
      {props.children}
    </ZenRoot>
  );
});
