import type { ProjectBrowserClient } from "@octant/client-runtime/project-browser-client";
import type { ProjectTerminalClient } from "@octant/client-runtime/project-terminal-client";
import { decodeCodeTerminalId, type CodeTerminalId } from "@octant/contracts/code";
import type { HostId } from "@octant/contracts/host";
import type { ProjectId } from "@octant/contracts/projects";
import { MIN_ZEN_RESEARCH_DOCK_WIDTH } from "@octant/contracts/zen";
import { ArrowLeft, Globe, SquareTerminal, type IconComponent } from "../ui/icons";
import {
  createContext,
  Suspense,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { ZenProjectResearchDock, ZenProjectTerminalCard } from "./deferredSurfaces";
import type { OctantHostBridge } from "./hostBridge";
import { serverCodeProjectFor, useServerCodeProjects } from "../projects/serverProjectEntries";
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
  /** The Project's extra folders, so a terminal can start in one; main otherwise. */
  readonly extraFolders?: (projectId: ProjectId) => ReadonlyArray<string>;
}

export const StartQuickToolsContext = createContext<StartQuickToolsServices | undefined>(undefined);

/**
 * The Project a Code start screen chose, handed to the right dock, which
 * holds that Project's quick tools while the new task waits for its thread.
 * They once stood as a 320px column beside the start screen as well, which
 * pushed the composer off centre and contradicted the dock.
 *
 * Each start screen registers under its own draft scope and the dock reads
 * only the active pane's. With one shared value, two Code start screens in
 * split panes overwrote each other, and a draft that became a thread cleared
 * the other's Project, so its dock said the tools waited for the task.
 */
export interface StartQuickToolsPlacement {
  /** The active Code draft's chosen Project. */
  readonly projectId: ProjectId | undefined;
  readonly chooseProject: (draftScope: string, projectId: ProjectId | undefined) => void;
  /** A press on the header's Project terminal or Project browser button, waiting for the dock. */
  readonly request?: QuickToolRequest | undefined;
  /** The dock took the request: a later mount must not replay it. */
  readonly consumeRequest?: (() => void) | undefined;
  /** Which tool the dock has open, so the header's button reads pressed. */
  readonly reportOpen?: ((tool: QuickToolKind | undefined) => void) | undefined;
}

export type QuickToolKind = "terminal" | "browser";

/** The header button asks the dock for a tool; the nonce tells two presses apart. */
export interface QuickToolRequest {
  readonly tool: QuickToolKind;
  readonly nonce: number;
}

export const StartQuickToolsPlacementContext = createContext<StartQuickToolsPlacement | undefined>(
  undefined,
);

export function StartQuickToolsPlacementProvider(props: {
  /** The draft scope of the active pane's Code start screen, if it has one. */
  readonly activeDraftScope: string | undefined;
  readonly children: ReactNode;
  readonly request?: QuickToolRequest | undefined;
  readonly onConsumeRequest?: () => void;
  readonly onOpenChange?: (tool: QuickToolKind | undefined) => void;
  /** The active draft's chosen Project, for the header's Project tool buttons. */
  readonly onProjectChange?: (projectId: ProjectId | undefined) => void;
}) {
  const [chosen, setChosen] = useState<ReadonlyMap<string, ProjectId>>(() => new Map());
  const chooseProject = useCallback((draftScope: string, projectId: ProjectId | undefined) => {
    setChosen((current) => {
      if (current.get(draftScope) === projectId) return current;
      const next = new Map(current);
      if (projectId === undefined) next.delete(draftScope);
      else next.set(draftScope, projectId);
      return next;
    });
  }, []);
  const projectId =
    props.activeDraftScope === undefined ? undefined : chosen.get(props.activeDraftScope);
  const onProjectChange = props.onProjectChange;
  useEffect(() => onProjectChange?.(projectId), [onProjectChange, projectId]);
  const { request, onConsumeRequest, onOpenChange } = props;
  const placement = useMemo<StartQuickToolsPlacement>(
    () => ({
      projectId,
      chooseProject,
      request,
      consumeRequest: onConsumeRequest,
      reportOpen: onOpenChange,
    }),
    [projectId, chooseProject, request, onConsumeRequest, onOpenChange],
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
 * The quick tools in the right dock for a new Code task: the chosen Project's
 * terminal and browser, opened in the dock without starting a thread. A Project
 * terminal has nothing else to reopen it from, so closing the panel (or
 * leaving the start screen) stops the shell rather than leave it running
 * unseen.
 */
export function StartQuickTools(props: { readonly projectId: ProjectId }) {
  const services = useContext(StartQuickToolsContext);
  const [open, setOpen] = useState<OpenTool>();
  const [starting, setStarting] = useState(false);
  const [message, setMessage] = useState<string>();
  const runningTerminal = useRef<CodeTerminalId | undefined>(undefined);
  // One start at a time, whoever asks: the list's row is disabled while a
  // shell starts, but a header button's request is not a press on that row,
  // and a second start would overwrite the first shell's id and leave it
  // running with nothing able to stop it.
  const startInFlight = useRef(false);
  // Which panel-and-Project a start belongs to. A shell that finishes starting
  // after the panel left or the Project changed is stopped, not adopted.
  const generation = useRef(0);
  const placement = useContext(StartQuickToolsPlacementContext);
  const reportOpen = placement?.reportOpen;
  const request = placement?.request;
  const consumeRequest = placement?.consumeRequest;
  // A server Project's terminal is a login on its server. It has no other
  // folder here, and the browser would be this computer's, so neither is offered.
  const onServer =
    serverCodeProjectFor(useServerCodeProjects().projects, props.projectId) !== undefined;

  // A shell opened here stops when the panel goes or the Project changes.
  useEffect(() => {
    const client = services?.projectTerminalClient;
    const projectId = props.projectId;
    return () => {
      generation.current += 1;
      const terminalId = runningTerminal.current;
      runningTerminal.current = undefined;
      if (client !== undefined && terminalId !== undefined) {
        void client.execute({ kind: "stop", projectId, terminalId }).catch(() => undefined);
      }
      setOpen(undefined);
    };
  }, [props.projectId, services?.projectTerminalClient]);

  useEffect(() => {
    reportOpen?.(open?.kind);
  }, [open?.kind, reportOpen]);
  // Leaving the dock leaves nothing open for the header's buttons to claim.
  useEffect(() => () => reportOpen?.(undefined), [reportOpen]);

  // The header's Project terminal and Project browser buttons ask for a tool
  // by request, so the dock opens straight into it. A request that arrived
  // before this dock mounted is taken on mount, then cleared, so it never
  // replays when the dock is shown again.
  const openRef = useRef(open);
  openRef.current = open;
  const takeRequest = useRef<(tool: QuickToolKind) => void>(() => undefined);
  useEffect(() => {
    if (request === undefined || services === undefined) return;
    consumeRequest?.();
    takeRequest.current(request.tool);
  }, [consumeRequest, request, services]);

  if (services === undefined) return null;
  const { projectTerminalClient } = services;

  async function openTerminal(folder?: string): Promise<void> {
    if (startInFlight.current) return;
    startInFlight.current = true;
    const startedFor = generation.current;
    setStarting(true);
    setMessage(undefined);
    const terminalId = decodeCodeTerminalId(crypto.randomUUID());
    const stop = () =>
      void projectTerminalClient
        .execute({ kind: "stop", projectId: props.projectId, terminalId })
        .catch(() => undefined);
    try {
      const started = await projectTerminalClient.execute({
        kind: "start",
        projectId: props.projectId,
        terminalId,
        columns: 80,
        rows: 24,
        ...(folder === undefined ? {} : { folder }),
      });
      if (started.kind === "project-terminal-refused") {
        setMessage(started.message);
        return;
      }
      if (started.kind !== "project-terminal" || started.terminal.state !== "running") {
        setMessage("The Project terminal did not start.");
        return;
      }
      if (startedFor !== generation.current) {
        stop();
        return;
      }
      runningTerminal.current = terminalId;
      setOpen({ kind: "terminal", terminalId });
    } catch {
      // The reply was lost, not necessarily the start: stop whatever began.
      setMessage("The Project terminal could not be started.");
      stop();
    } finally {
      startInFlight.current = false;
      setStarting(false);
    }
  }

  takeRequest.current = (tool) => {
    // A request that lands while a shell is starting is dropped: the tool it
    // asks for is either that shell or one the person can ask for again.
    if (startInFlight.current) return;
    if (openRef.current?.kind === tool) return;
    if (openRef.current !== undefined) close();
    if (tool === "browser") {
      if (!onServer) setOpen({ kind: "browser" });
    } else void openTerminal();
  };

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

  if (open === undefined) {
    return (
      // The dock's title band is already the "Quick tools" group.
      <aside aria-label="Project tools" className="start-quick-tools">
        <div className="start-quick-tools__list" role="group" aria-label="Open for this Project">
          <QuickToolRow
            disabled={starting}
            icon={SquareTerminal}
            label={starting ? "Starting terminal…" : "Terminal"}
            onSelect={() => void openTerminal()}
          />
          {(onServer ? [] : (services.extraFolders?.(props.projectId) ?? [])).map((folder) => (
            <QuickToolRow
              disabled={starting}
              icon={SquareTerminal}
              key={folder}
              label={`Terminal in ${folder.split("/").filter(Boolean).at(-1) ?? folder}`}
              onSelect={() => void openTerminal(folder)}
            />
          ))}
          {onServer ? null : (
            <QuickToolRow
              disabled={starting}
              icon={Globe}
              label="Browser"
              onSelect={() => {
                setMessage(undefined);
                setOpen({ kind: "browser" });
              }}
            />
          )}
          {message === undefined ? null : (
            <OctantAlert className="start-quick-tools__message" tone="warning">
              {message}
            </OctantAlert>
          )}
          <p className="oct-row-detail start-quick-tools__note">
            Other tools open once the task starts
          </p>
        </div>
      </aside>
    );
  }

  return (
    <aside
      aria-label={open.kind === "terminal" ? "Project terminal" : "Project browser"}
      className="start-quick-tools start-quick-tools--open"
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
  readonly icon: IconComponent;
  readonly label: string;
  readonly disabled: boolean;
  readonly onSelect: () => void;
}) {
  const Icon = props.icon;
  return (
    <OctantButton disabled={props.disabled} onClick={props.onSelect} type="button" variant="ghost">
      <span className="start-quick-tools__row">
        <Icon aria-hidden="true" size={16} />
        <span>{props.label}</span>
      </span>
    </OctantButton>
  );
}
