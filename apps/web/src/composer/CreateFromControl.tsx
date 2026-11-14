import type { GithubClient } from "@octant/client-runtime/github-client";
import type { IntegrationClient } from "@octant/client-runtime/integration-client";
import type { TerminalSessionClient } from "@octant/client-runtime/terminal-session-client";
import type {
  GithubIssueContextRequest,
  LinearIssueContextRequest,
  ProjectId,
  TerminalSessionImportRequest,
  TerminalSessionSummary,
} from "@octant/contracts";
import { useEffect } from "react";
import { moveWithinTabList } from "../ui/base/radioGroupKeys";
import {
  loadGithubRecentRepositories,
  loadGithubRepositories,
} from "../code/GitHubRepositoryPicker";
import { CreateFromIssuePicker } from "../github/CreateFromIssuePicker";
import {
  CreateFromLinearIssuePicker,
  loadLinearIssues,
} from "../linear/CreateFromLinearIssuePicker";
import {
  CreateFromTerminalSessionPicker,
  loadTerminalSessions,
} from "../terminalSessions/CreateFromTerminalSessionPicker";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantPopover } from "../ui/base/OctantPopover";

export type CreateFromTab = "github" | "linear" | "terminal";

export interface CreateFromSources {
  readonly githubClient?: GithubClient | undefined;
  readonly linearClient?: IntegrationClient | undefined;
  readonly terminalSessions?:
    | { readonly client: TerminalSessionClient; readonly projectId: ProjectId }
    | undefined;
}

/**
 * Reads the lists the popup shows before anyone opens it, so the rows are on
 * screen from its first frame. Safe to call as often as the pointer visits the
 * trigger: an answer that is still fresh is not asked for again.
 */
function readAhead(sources: CreateFromSources): void {
  const ignore = () => undefined;
  if (sources.githubClient !== undefined) {
    void loadGithubRepositories(sources.githubClient).catch(ignore);
    void loadGithubRecentRepositories(sources.githubClient).catch(ignore);
  }
  if (sources.linearClient !== undefined) void loadLinearIssues(sources.linearClient).catch(ignore);
  if (sources.terminalSessions !== undefined) {
    void loadTerminalSessions(
      sources.terminalSessions.client,
      sources.terminalSessions.projectId,
    ).catch(ignore);
  }
}

/**
 * "Create from…" at the end of the start composer's row. The popup is one
 * fixed frame: its tabs, its search and its list area stand in the same boxes
 * whether the rows have arrived or not, so nothing in it resizes, moves or
 * jumps while it loads or while a tab is chosen.
 */
export function CreateFromControl(
  props: CreateFromSources & {
    readonly creating: boolean;
    readonly open: boolean;
    readonly tab: CreateFromTab;
    readonly onTabChange: (tab: CreateFromTab) => void;
    readonly selectedGithub?: GithubIssueContextRequest;
    readonly selectedLinear?: LinearIssueContextRequest;
    readonly selectedTerminal?: TerminalSessionImportRequest;
    readonly onSelectTerminal: (session: TerminalSessionSummary) => void;
    readonly selectedLabel?: string;
    readonly onSelectGithub: (issue: GithubIssueContextRequest, title: string) => void;
    readonly onSelectLinear: (
      issue: LinearIssueContextRequest & { readonly identifier: string },
      title: string,
    ) => void;
    readonly onClear: () => void;
    readonly onToggle: () => void;
  },
) {
  const { githubClient, linearClient, terminalSessions } = props;
  const terminalProject = terminalSessions?.projectId;
  const showGithub = githubClient !== undefined;
  const showLinear = linearClient !== undefined;
  const showTerminal = terminalSessions !== undefined;

  // When the control mounts and whenever the Project changes, so a reopen is instant.
  useEffect(() => {
    readAhead({ githubClient, linearClient, terminalSessions });
  }, [githubClient, linearClient, terminalSessions?.client, terminalProject]);

  const activeTab: CreateFromTab =
    props.tab === "linear" && showLinear
      ? "linear"
      : props.tab === "github" && showGithub
        ? "github"
        : props.tab === "terminal" && showTerminal
          ? "terminal"
          : showGithub
            ? "github"
            : showLinear
              ? "linear"
              : "terminal";
  const tabs: ReadonlyArray<{ readonly id: CreateFromTab; readonly label: string }> = [
    ...(showGithub ? [{ id: "github" as const, label: "GitHub" }] : []),
    ...(showLinear ? [{ id: "linear" as const, label: "Linear" }] : []),
    ...(showTerminal ? [{ id: "terminal" as const, label: "Terminal" }] : []),
  ];
  const panel = (
    <div className="create-from-popup__panel">
      <div
        aria-label="Create from"
        className="segmented create-from-popup__tabs"
        onKeyDown={moveWithinTabList}
        role="tablist"
      >
        {tabs.map((tab) => (
          <OctantButton
            aria-selected={activeTab === tab.id}
            className="segment"
            key={tab.id}
            onClick={() => props.onTabChange(tab.id)}
            role="tab"
            tabIndex={activeTab === tab.id ? 0 : -1}
            type="button"
            variant="bare"
          >
            {tab.label}
          </OctantButton>
        ))}
      </div>
      <div className="create-from-popup__body" role="tabpanel">
        {activeTab === "github" && githubClient !== undefined ? (
          <CreateFromIssuePicker
            client={githubClient}
            disabled={props.creating}
            onSelect={props.onSelectGithub}
            {...(props.selectedGithub === undefined ? {} : { selected: props.selectedGithub })}
          />
        ) : null}
        {activeTab === "linear" && linearClient !== undefined ? (
          <CreateFromLinearIssuePicker
            client={linearClient}
            disabled={props.creating}
            onSelect={props.onSelectLinear}
            {...(props.selectedLinear === undefined ? {} : { selected: props.selectedLinear })}
          />
        ) : null}
        {activeTab === "terminal" && terminalSessions !== undefined ? (
          <CreateFromTerminalSessionPicker
            client={terminalSessions.client}
            disabled={props.creating}
            onSelect={props.onSelectTerminal}
            projectId={terminalSessions.projectId}
            {...(props.selectedTerminal === undefined ? {} : { selected: props.selectedTerminal })}
          />
        ) : null}
      </div>
    </div>
  );
  const read = () => readAhead({ githubClient, linearClient, terminalSessions });
  return (
    <div className="create-from-issue-control">
      <div className="create-from-issue-control__bar" onFocusCapture={read} onPointerEnter={read}>
        <OctantPopover
          align="end"
          className="create-from-popup"
          onOpenChange={(open) => {
            if (open !== props.open) props.onToggle();
          }}
          open={props.open}
          side="top"
          sideOffset={6}
          title={
            showGithub || showLinear ? "Create from an issue or session" : "Create from a session"
          }
          trigger={<>Create from…</>}
          triggerDisabled={props.creating}
          triggerLabel="Create from…"
          triggerVariant="ghost"
        >
          {panel}
        </OctantPopover>
        {props.selectedLabel === undefined ? null : (
          <span className="create-from-issue-control__selection">
            <span>{props.selectedLabel}</span>
            <OctantButton
              aria-label="Remove what this thread starts from"
              disabled={props.creating}
              onClick={props.onClear}
              size="sm"
              type="button"
              variant="ghost"
            >
              Remove
            </OctantButton>
          </span>
        )}
      </div>
    </div>
  );
}
