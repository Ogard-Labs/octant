import type { ProjectBrowserClient } from "@octant/client-runtime/project-browser-client";
import type { ProjectTerminalClient } from "@octant/client-runtime/project-terminal-client";
import { decodeCodeTerminalId, type CodeTerminalId } from "@octant/contracts/code";
import type { HostId } from "@octant/contracts/host";
import type { ProjectId } from "@octant/contracts/projects";
import { MIN_ZEN_RESEARCH_DOCK_WIDTH } from "@octant/contracts/zen";
import { ArrowLeft, Globe, SquareTerminal, type LucideIcon } from "lucide-react";
import {
  createContext,
  Suspense,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { ZenProjectResearchDock, ZenProjectTerminalCard } from "./deferredSurfaces";
import type { OctantHostBridge } from "./hostBridge";
import { OctantAlert } from "../ui/base/OctantAlert";
import { OctantButton } from "../ui/base/OctantButton";
import "../styles/start-quick-tools.css";

/**
 * What a start screen needs to open a Project's own tools. A Project terminal
 * and a Project browser belong to the window and the Project, never a thread,
 * so a start screen (which has no thread yet) can open them. Absent outside
 * the local desktop or browser window that holds these clients.
 */
export interface StartQuickToolsServices {
  readonly hostId: HostId;
  readonly projectTerminalClient: ProjectTerminalClient;
  readonly projectBrowserClient: ProjectBrowserClient;
  readonly hostBridge?: OctantHostBridge;
}

export const StartQuickToolsContext = createContext<StartQuickToolsServices | undefined>(undefined);

/**
 * Where a Code start screen's quick tools stand. The right dock holds its
 * place for a new Code task and said its tools were unavailable, while a
 * 320px quick-tools column beside it offered a terminal and a browser and
 * pushed the composer off centre. When the dock is open for that task it
 * holds the quick tools itself, for the Project the start screen chose.
 */
export interface StartQuickToolsPlacement {
  readonly inDock: boolean;
  readonly projectId: ProjectId | undefined;
  readonly chooseProject: (projectId: ProjectId | undefined) => void;
}

export const StartQuickToolsPlacementContext = createContext<StartQuickToolsPlacement | undefined>(
  undefined,
);

export function StartQuickToolsPlacementProvider(props: {
  readonly inDock: boolean;
  readonly children: ReactNode;
}) {
  const [projectId, setProjectId] = useState<ProjectId>();
  const placement = useMemo<StartQuickToolsPlacement>(
    () => ({ inDock: props.inDock, projectId, chooseProject: setProjectId }),
    [props.inDock, projectId],
  );
  return (
    <StartQuickToolsPlacementContext.Provider value={placement}>
      {props.children}
    </StartQuickToolsPlacementContext.Provider>
  );
}

type OpenTool =
  | { readonly kind: "terminal"; readonly terminalId: CodeTerminalId }
  | { readonly kind: "browser" };

/**
 * The quick tools beside a Code start screen: the chosen Project's terminal
 * and browser, opened in this panel without starting a thread. A Project
 * terminal has nothing else to reopen it from, so closing the panel (or
 * leaving the start screen) stops the shell rather than leave it running
 * unseen.
 */
export function StartQuickTools(props: {
  readonly projectId: ProjectId;
  /** In the dock, the tools fill its body and say the rest wait for the task. */
  readonly inDock?: boolean;
}) {
  const services = useContext(StartQuickToolsContext);
  const [open, setOpen] = useState<OpenTool>();
  const [starting, setStarting] = useState(false);
  const [message, setMessage] = useState<string>();
  const runningTerminal = useRef<CodeTerminalId | undefined>(undefined);

  // A shell opened here stops when the panel goes or the Project changes.
  useEffect(() => {
    const client = services?.projectTerminalClient;
    const projectId = props.projectId;
    return () => {
      const terminalId = runningTerminal.current;
      runningTerminal.current = undefined;
      if (client !== undefined && terminalId !== undefined) {
        void client.execute({ kind: "stop", projectId, terminalId }).catch(() => undefined);
      }
      setOpen(undefined);
    };
  }, [props.projectId, services?.projectTerminalClient]);

  if (services === undefined) return null;
  const { projectTerminalClient } = services;

  async function openTerminal(): Promise<void> {
    setStarting(true);
    setMessage(undefined);
    const terminalId = decodeCodeTerminalId(crypto.randomUUID());
    try {
      const started = await projectTerminalClient.execute({
        kind: "start",
        projectId: props.projectId,
        terminalId,
        columns: 80,
        rows: 24,
      });
      if (started.kind === "project-terminal-refused") {
        setMessage(started.message);
        return;
      }
      if (started.kind !== "project-terminal" || started.terminal.state !== "running") {
        setMessage("The Project terminal did not start.");
        return;
      }
      runningTerminal.current = terminalId;
      setOpen({ kind: "terminal", terminalId });
    } catch {
      // The reply was lost, not necessarily the start: stop whatever began.
      setMessage("The Project terminal could not be started.");
      void projectTerminalClient
        .execute({ kind: "stop", projectId: props.projectId, terminalId })
        .catch(() => undefined);
    } finally {
      setStarting(false);
    }
  }

  function close(): void {
    const terminalId = runningTerminal.current;
    runningTerminal.current = undefined;
    if (terminalId !== undefined) {
      void projectTerminalClient
        .execute({ kind: "stop", projectId: props.projectId, terminalId })
        .catch(() => undefined);
    }
    setOpen(undefined);
  }

  const dockClass = props.inDock === true ? " start-quick-tools--dock" : "";
  if (open === undefined) {
    return (
      <aside
        // The dock's title band is already the "Quick tools" group.
        aria-label={props.inDock === true ? "Project tools" : "Quick tools"}
        className={`start-quick-tools${dockClass}`}
      >
        <div className="start-quick-tools__list" role="group" aria-label="Open for this Project">
          <QuickToolRow
            disabled={starting}
            icon={SquareTerminal}
            label={starting ? "Starting terminal…" : "Terminal"}
            onSelect={() => void openTerminal()}
          />
          <QuickToolRow
            disabled={starting}
            icon={Globe}
            label="Browser"
            onSelect={() => {
              setMessage(undefined);
              setOpen({ kind: "browser" });
            }}
          />
          {message === undefined ? null : (
            <OctantAlert className="start-quick-tools__message" tone="warning">
              {message}
            </OctantAlert>
          )}
          {props.inDock === true ? (
            <p className="oct-row-detail start-quick-tools__note">
              Other tools open once the task starts
            </p>
          ) : null}
        </div>
      </aside>
    );
  }

  return (
    <aside
      aria-label={open.kind === "terminal" ? "Project terminal" : "Project browser"}
      className={`start-quick-tools start-quick-tools--open${dockClass}`}
    >
      <header className="start-quick-tools__head">
        <OctantButton onClick={close} size="sm" type="button" variant="ghost">
          <span className="start-quick-tools__back">
            <ArrowLeft aria-hidden="true" size={14} />
            Quick tools
          </span>
        </OctantButton>
      </header>
      <div className="start-quick-tools__body">
        <Suspense fallback={null}>
          {open.kind === "terminal" ? (
            <ZenProjectTerminalCard
              client={projectTerminalClient}
              live
              projectId={props.projectId}
              terminalId={open.terminalId}
            />
          ) : (
            <ZenProjectResearchDock
              client={services.projectBrowserClient}
              dock={{
                project: { hostId: services.hostId, projectId: props.projectId, mode: "code" },
                width: MIN_ZEN_RESEARCH_DOCK_WIDTH,
                collapsed: false,
              }}
              {...(services.hostBridge === undefined ? {} : { hostBridge: services.hostBridge })}
              onCollapse={(collapsed) => {
                if (collapsed) close();
              }}
              onUndock={close}
            />
          )}
        </Suspense>
      </div>
    </aside>
  );
}

function QuickToolRow(props: {
  readonly icon: LucideIcon;
  readonly label: string;
  readonly disabled: boolean;
  readonly onSelect: () => void;
}) {
  const Icon = props.icon;
  return (
    <OctantButton disabled={props.disabled} onClick={props.onSelect} type="button" variant="ghost">
      <span className="start-quick-tools__row">
        <Icon aria-hidden="true" size={16} strokeWidth={1.6} />
        <span>{props.label}</span>
      </span>
    </OctantButton>
  );
}
