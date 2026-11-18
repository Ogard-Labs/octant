import { DEFAULT_THEME_SETTINGS } from "@octant/contracts/theme";
import type { ProjectId } from "@octant/contracts/projects";
import { defaultShellSettings } from "@octant/domain/shell-policy";
import type { ReactNode } from "react";
import { AgentsCenter } from "../agents/AgentsCenter";
import { ArtifactLibraryView } from "../artifacts/ArtifactLibraryView";
import { INITIAL_ARTIFACT_FILTERS } from "../artifacts/useArtifactLibrary";
import { AutomationCenter } from "../automation/AutomationCenter";
import { CodeWhereControl } from "../code/composer/CodeWhereControl";
import { PermissionModePicker } from "../code/PermissionModePicker";
import { ComposerStartTray } from "../composer/ComposerStartTray";
import { ThreadComposer } from "../composer/ThreadComposer";
import { WelcomeHeading } from "../composer/WelcomeHeading";
import { CodeThreadEnvironment } from "../environment/CodeThreadEnvironment";
import { ComposerProjectSelector } from "../projects/ComposerProjectSelector";
import { SettingsView } from "../shell/SettingsView";
import { RailAccount } from "../shell/SidebarProfile";
import { SidebarRail } from "../shell/SidebarRail";
import type { ThemeController } from "../theme/useThemeController";
import { OctantTextarea } from "../ui/base/OctantTextarea";
import { PlanUsageProvider } from "../usage/PlanUsageContext";
import { SCENE_LIST, type SceneMeta } from "./sceneList";
import {
  agentRunClient,
  ARTIFACT_LISTING,
  automationCatalog,
  automationClient,
  CLAUDE_ACCOUNT,
  CODE_PROJECT,
  CODE_TAB,
  codeProjectClient,
  planUsageClient,
  threadRoutinesClient,
  threadUsageClient,
  USAGE_LEDGER,
  VISUAL_NOW,
} from "./fixtures";

export interface VisualScene extends SceneMeta {
  readonly render: () => ReactNode;
}

const noop = (): void => undefined;

const PROJECT_ENTRIES = [
  {
    kind: "saved-project" as const,
    projectId: "00000000-0000-4000-8000-000000000101" as ProjectId,
    displayName: "Octant",
    rootPath: "/Users/example/Dev/Repos/octant",
  },
  {
    kind: "saved-project" as const,
    projectId: "00000000-0000-4000-8000-000000000102" as ProjectId,
    displayName: "Storefront",
    rootPath: "/Users/example/Dev/Repos/storefront",
  },
  {
    kind: "saved-project" as const,
    projectId: "00000000-0000-4000-8000-000000000103" as ProjectId,
    displayName: "Field notes",
    rootPath: "/Users/example/Documents/field-notes",
  },
  { kind: "default-folder" as const, rootPath: "/Users/example/Octant/Work" },
  { kind: "add-folder" as const },
];

const PROJECT_SELECTION = {
  projectId: "00000000-0000-4000-8000-000000000101" as ProjectId,
  displayName: "Octant",
};

function themeController(): ThemeController {
  return {
    status: "ready",
    settings: DEFAULT_THEME_SETTINGS,
    draft: DEFAULT_THEME_SETTINGS,
    version: 1,
    error: undefined,
    hasDraftChanges: false,
    updateDraft: noop,
    applyPatch: async () => true,
    apply: async () => true,
    cancel: noop,
    reset: noop,
    importJson: async () => undefined,
    exportJson: () => undefined,
    exportTokens: () => undefined,
  } as unknown as ThemeController;
}

function Pane(props: { readonly children: ReactNode; readonly padded?: boolean }) {
  return (
    <div
      className={
        props.padded === true
          ? "visual-check__pane visual-check__pane--padded"
          : "visual-check__pane"
      }
    >
      {props.children}
    </div>
  );
}

function Stage(props: { readonly children: ReactNode }) {
  return <div className="visual-check__stage">{props.children}</div>;
}

/**
 * The start screen: the question, the composer with its Project row, and the
 * approval control. A start screen is a draft-thread surface of the whole app
 * shell, so this draws its heading and the shared composer frame the same way
 * the shell does, with a plain text message field and no host behind it. The
 * model picker is left out because it reads the provider registry.
 */
function HomeScene() {
  return (
    <section aria-label="New code thread" className="draft-thread">
      <div className="welcome">
        <div className="welcome__heading">
          <WelcomeHeading projectChosen projectName="Octant" />
        </div>
        <div className="composer-stack">
          <ThreadComposer
            input={
              <OctantTextarea
                aria-label="First message"
                className="composer-input"
                onChange={noop}
                placeholder="Describe what to build"
                rows={3}
                value=""
              />
            }
            notices={[]}
            row={{
              actions: { kind: "send", send: { ariaLabel: "Start", disabled: true } },
              approval: <PermissionModePicker autoSupported onChange={noop} value="ask-first" />,
            }}
            startContext={
              <ComposerStartTray
                project={
                  <ComposerProjectSelector
                    entries={PROJECT_ENTRIES}
                    onAddFolder={noop}
                    onSelect={noop}
                    selection={PROJECT_SELECTION}
                  />
                }
              />
            }
          />
        </div>
      </div>
    </section>
  );
}

function RailScene() {
  const profile = { ...defaultShellSettings().userProfile, displayName: "Ada Lovelace" };
  return (
    <PlanUsageProvider barStyle="smooth" client={planUsageClient()} instances={[CLAUDE_ACCOUNT]}>
      <div style={{ height: "100%", width: 48, display: "flex" }}>
        <SidebarRail
          account={<RailAccount onOpenNavigator={noop} onOpenSettings={noop} profile={profile} />}
          activeMode="code"
          destinations={[
            { id: "agents", label: "Agents", onSelect: noop, active: false },
            { id: "automations", label: "Automations", onSelect: noop, active: false },
          ]}
          home={{ onOpen: noop, active: true }}
          modes={["chat", "work", "code"]}
          nativeHost={false}
          newThread={{ label: "New task", onSelect: noop }}
          onOpenSearch={noop}
          onOpenSettings={noop}
          onSelectMode={noop}
          pinnedProjects={[
            { id: "p1", name: "Octant", active: true, onOpen: noop },
            { id: "p2", name: "Storefront", active: false, onOpen: noop },
          ]}
          placement="collapsed"
          projects={[{ id: "p3", name: "Field notes", active: false, onOpen: noop }]}
          tiles={[
            { id: "inbox", count: 3, onSelect: noop },
            { id: "running", count: 1, onSelect: noop },
            { id: "review", count: 2, onSelect: noop },
            { id: "done", count: 4, onSelect: noop },
          ]}
        />
      </div>
    </PlanUsageProvider>
  );
}

const RENDERERS: ReadonlyArray<{ readonly id: string; readonly render: () => ReactNode }> = [
  { id: "home", render: () => <HomeScene /> },
  {
    // The side panel is the dock's Environment tool. The panel renders in place
    // when no dock host exists, so it is drawn on its own in a dock-width pane.
    id: "code-side-panel",
    render: () => (
      <Pane>
        <div style={{ width: 320 }}>
          <CodeThreadEnvironment
            active
            automationClient={threadRoutinesClient()}
            deliveryOutcome="opened-pr"
            environmentOpen
            onExecute={async () => undefined}
            onOpenRoutine={noop}
            onOpenUsageDashboard={noop}
            project={CODE_PROJECT}
            projectClient={codeProjectClient()}
            tab={CODE_TAB}
            usageDashboardClient={threadUsageClient()}
          >
            {null}
          </CodeThreadEnvironment>
        </div>
      </Pane>
    ),
  },
  {
    id: "settings-appearance",
    render: () => (
      <SettingsView
        initialDeepLink={{ section: "appearance" }}
        nativeBoundsAvailable
        onResetLayout={noop}
        onResetNativeBounds={noop}
        onSearchChange={noop}
        onSettingsChange={noop}
        search=""
        settings={defaultShellSettings()}
        sidebarVibrancySupported
        themeController={themeController()}
      />
    ),
  },
  {
    id: "settings-usage",
    render: () => (
      <SettingsView
        initialDeepLink={{ section: "usage" }}
        nativeBoundsAvailable
        onResetLayout={noop}
        onResetNativeBounds={noop}
        onSearchChange={noop}
        onSettingsChange={noop}
        search=""
        settings={defaultShellSettings()}
        sidebarVibrancySupported
        usageClient={
          {
            query: async () => USAGE_LEDGER,
            export: noop,
            reset: noop,
            retain: noop,
          } as never
        }
      />
    ),
  },
  {
    id: "agents-table",
    render: () => (
      <Pane>
        <AgentsCenter client={agentRunClient()} />
      </Pane>
    ),
  },
  {
    id: "artifacts-table",
    render: () => (
      <Pane padded>
        <ArtifactLibraryView
          busy={false}
          filters={{ ...INITIAL_ARTIFACT_FILTERS, tab: "all" }}
          listing={ARTIFACT_LISTING}
          observedAt={VISUAL_NOW}
          onFiltersChange={noop}
          onOpen={noop}
          onViewChange={noop}
          view="list"
        />
      </Pane>
    ),
  },
  {
    id: "automations-table",
    render: () => (
      <Pane>
        <AutomationCenter
          catalog={automationCatalog()}
          client={automationClient()}
          displayTimeZone="UTC"
          localHostId="local"
          now={() => VISUAL_NOW}
        />
      </Pane>
    ),
  },
  {
    id: "where-menu",
    render: () => (
      <Stage>
        <CodeWhereControl
          branch="main"
          onWorkspaceChange={noop}
          projectRoot="/Users/example/Dev/Repos/octant"
          remembered={{ value: "current-checkout", onChange: noop }}
          workspace="current-checkout"
          worktreeBranch="feature/issue-204"
        />
      </Stage>
    ),
  },
  {
    id: "project-picker",
    render: () => (
      <Stage>
        <ComposerProjectSelector
          entries={PROJECT_ENTRIES}
          onAddFolder={noop}
          onSelect={noop}
          selection={PROJECT_SELECTION}
        />
      </Stage>
    ),
  },
  {
    id: "mode-picker",
    render: () => (
      <Stage>
        <PermissionModePicker autoSupported onChange={noop} value="ask-first" />
      </Stage>
    ),
  },
  { id: "rail", render: () => <RailScene /> },
];

export const SCENES: ReadonlyArray<VisualScene> = SCENE_LIST.map((meta) => {
  const renderer = RENDERERS.find((candidate) => candidate.id === meta.id);
  if (renderer === undefined) throw new Error(`Scene ${meta.id} has no renderer.`);
  return { ...meta, render: renderer.render };
});

export function sceneById(id: string): VisualScene | undefined {
  return SCENES.find((scene) => scene.id === id);
}
