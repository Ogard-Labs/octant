import type { AgentRunCenterSummary } from "@octant/contracts";
import type { AgentRunClient } from "@octant/client-runtime/agent-run-client";
import { Search } from "lucide-react";
import { useMemo, useState } from "react";
import { ShellState } from "../shell/ShellState";
import { OctantBadge } from "../ui/base/OctantBadge";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantInput } from "../ui/base/OctantInput";
import { OctantToggleGroup, OctantToggleGroupItem } from "../ui/base/OctantToggleGroup";
import {
  agentRunAcknowledgementLabel,
  agentRunAuthoritySummary,
  agentRunCenterThreadTarget,
  agentRunLifecycleLabel,
  agentRunModeLabel,
  agentRunRecoveryLabel,
  agentRunRouteLabel,
  agentRunUsageQualityLabel,
  agentRunWorkspaceLabel,
  type AgentsCenterThreadTarget,
} from "./agentsCenterModel";
import { useAgentRunControlCommands } from "./useAgentRunControlCommands";
import {
  useAgentsCenterController,
  type AgentsCenterController,
} from "./useAgentsCenterController";

export interface AgentsCenterProps {
  readonly client: AgentRunClient;
  readonly onOpenThread?: (target: AgentsCenterThreadTarget & { readonly title: string }) => void;
  readonly onClose?: () => void;
  readonly narrow?: boolean;
  readonly projectNames?: ReadonlyMap<string, string>;
  readonly providerLabels?: ReadonlyMap<string, string>;
}

const STATUS_FILTERS = [
  { value: "all", label: "All" },
  { value: "active", label: "Active" },
  { value: "history", label: "History" },
] as const;

const MODE_FILTERS = [
  { value: "all", label: "All modes" },
  { value: "chat", label: "Chat" },
  { value: "work", label: "Work" },
  { value: "code", label: "Code" },
] as const;

export function AgentsCenter(props: AgentsCenterProps) {
  const controller = useAgentsCenterController({ client: props.client });
  const controls = useAgentRunControlCommands(props.client, controller.retryList);
  const selected = useMemo(
    () => controller.visibleItems.find((item) => String(item.runId) === controller.selectedId),
    [controller.selectedId, controller.visibleItems],
  );
  const detailOpen = controller.selectedId !== undefined;
  const hideListForNarrow = props.narrow === true && detailOpen;

  return (
    <section
      aria-label="Agents Center"
      className="agents-center"
      data-narrow={props.narrow === true}
    >
      <header className="agents-center__header">
        <div>
          <h2 className="agents-center__title">Agents Center</h2>
          <p className="agents-center__subtitle">
            Active and historical child runs across Chat, Work, and Code.
          </p>
        </div>
        {props.onClose === undefined ? null : (
          <OctantButton onClick={props.onClose} type="button" variant="secondary">
            Back to workspace
          </OctantButton>
        )}
      </header>

      {controller.notice === undefined ? null : (
        <div className="agents-center__notice" role="status">
          <span>{controller.notice}</span>
          <OctantButton onClick={controller.clearNotice} type="button" variant="ghost">
            Dismiss
          </OctantButton>
        </div>
      )}

      <div className="agents-center__body">
        {hideListForNarrow ? null : (
          <div className="agents-center__list-pane">
            <AgentsCenterToolbar controller={controller} />
            <AgentsCenterListBody
              controller={controller}
              controls={controls}
              onOpenThread={props.onOpenThread}
              projectNames={props.projectNames ?? new Map()}
              providerLabels={props.providerLabels ?? new Map()}
              onSelect={(runId) => controller.select(runId)}
            />
          </div>
        )}

        {selected === undefined ? null : (
          <div className="agents-center__detail-pane">
            <AgentsCenterDetail
              controls={controls}
              controller={controller}
              narrow={props.narrow === true}
              onBack={() => controller.select(undefined)}
              onOpenThread={props.onOpenThread}
              projectNames={props.projectNames ?? new Map()}
              providerLabels={props.providerLabels ?? new Map()}
              summary={selected}
            />
          </div>
        )}
      </div>
    </section>
  );
}

function AgentsCenterToolbar(props: { readonly controller: AgentsCenterController }) {
  const { controller } = props;
  return (
    <div aria-label="Agents Center controls" className="agents-center__toolbar" role="group">
      <label className="agents-center__search">
        <span className="sr-only">Search agent runs</span>
        <Search aria-hidden="true" size={14} strokeWidth={1.8} />
        <OctantInput
          onChange={(event) => controller.setSearch(event.target.value)}
          placeholder="Search tasks, roles, threads"
          type="search"
          value={controller.search}
        />
      </label>
      <OctantToggleGroup<(typeof STATUS_FILTERS)[number]["value"]>
        aria-label="Filter by status"
        className="agents-center__filters segmented"
        onValueChange={(value) => {
          const selected = value[0];
          if (selected !== undefined) controller.setStatusFilter(selected);
        }}
        value={[controller.statusFilter]}
      >
        {STATUS_FILTERS.map((filter) => (
          <OctantToggleGroupItem
            className="agents-center__filter segment"
            key={filter.value}
            value={filter.value}
          >
            {filter.label}
          </OctantToggleGroupItem>
        ))}
      </OctantToggleGroup>
      <OctantToggleGroup<(typeof MODE_FILTERS)[number]["value"]>
        aria-label="Filter by mode"
        className="agents-center__filters segmented"
        onValueChange={(value) => {
          const selected = value[0];
          if (selected !== undefined) controller.setModeFilter(selected);
        }}
        value={[controller.modeFilter]}
      >
        {MODE_FILTERS.map((filter) => (
          <OctantToggleGroupItem
            className="agents-center__filter segment"
            key={filter.value}
            value={filter.value}
          >
            {filter.label}
          </OctantToggleGroupItem>
        ))}
      </OctantToggleGroup>
    </div>
  );
}

function AgentsCenterListBody(props: {
  readonly controller: AgentsCenterController;
  readonly controls: ReturnType<typeof useAgentRunControlCommands>;
  readonly onOpenThread?: AgentsCenterProps["onOpenThread"];
  readonly projectNames: ReadonlyMap<string, string>;
  readonly providerLabels: ReadonlyMap<string, string>;
  readonly onSelect: (runId: string) => void;
}) {
  const { controller } = props;
  if (controller.list.status === "loading") {
    return (
      <ShellState
        eyebrow="Agents Center"
        message="Loading agent runs."
        state="loading"
        title="Loading"
      />
    );
  }
  if (controller.list.status === "unavailable") {
    return (
      <ShellState
        action={{ label: "Retry", onClick: controller.retryList }}
        eyebrow="Agents Center"
        message={controller.list.message}
        role="alert"
        state="disconnected"
        title="Agents Center is unavailable"
      />
    );
  }
  if (controller.visibleItems.length === 0) {
    return (
      <div className="agents-center__empty empty" role="status">
        <p>No agent runs match the current filters.</p>
        <p>Nothing was deleted; adjust the filters or create a child from a thread.</p>
      </div>
    );
  }
  return (
    <ul aria-label="Agent runs" className="agents-center__rows">
      {controller.visibleItems.map((summary) => (
        <li className="agents-center-row" key={String(summary.runId)}>
          <OctantButton
            className="agents-center-row__open"
            data-agent-run-row={String(summary.runId)}
            onClick={() => props.onSelect(String(summary.runId))}
            type="button"
            variant="ghost"
          >
            <span className="agents-center-row__task">{summary.task}</span>
          </OctantButton>
          <div className="agents-center-row__meta">
            <span className="agents-center-row__parent">{summary.parentThreadTitle}</span>
            <span className="agents-center-row__mode">{agentRunModeLabel(summary.mode)}</span>
            <span className="agents-center-row__project">
              {summary.projectId === undefined
                ? "No Project"
                : (props.projectNames.get(String(summary.projectId)) ?? "Project")}
            </span>
            <span className="agents-center-row__provider">
              {props.providerLabels.get(String(summary.route.requestedProviderInstanceId)) ??
                summary.route.requestedModelId}
            </span>
            <span className="agents-center-row__state" data-lifecycle={summary.lifecycleStatus}>
              {agentRunLifecycleLabel(summary.lifecycleStatus)}
            </span>
            {summary.resultAcknowledgement.required &&
            !summary.resultAcknowledgement.acknowledged ? (
              <OctantBadge className="agents-center-row__ack" variant="secondary">
                Needs acknowledgement
              </OctantBadge>
            ) : null}
          </div>
          <div className="agents-center-row__actions">
            <OctantButton
              onClick={() => {
                const target = agentRunCenterThreadTarget(summary);
                props.onOpenThread?.({
                  ...target,
                  title: summary.parentThreadTitle,
                });
              }}
              type="button"
              variant="ghost"
            >
              Open thread
            </OctantButton>
            {summary.resultAcknowledgement.required &&
            !summary.resultAcknowledgement.acknowledged ? (
              <OctantButton
                onClick={() =>
                  void props.controls
                    .acknowledge({ runId: String(summary.runId), version: summary.version })
                    .then((message) => {
                      if (message !== undefined) controller.setNotice(message);
                    })
                }
                type="button"
                variant="secondary"
              >
                Acknowledge
              </OctantButton>
            ) : null}
          </div>
        </li>
      ))}
    </ul>
  );
}

function AgentsCenterDetail(props: {
  readonly summary: AgentRunCenterSummary;
  readonly controller: AgentsCenterController;
  readonly controls: ReturnType<typeof useAgentRunControlCommands>;
  readonly narrow: boolean;
  readonly onBack: () => void;
  readonly onOpenThread?: AgentsCenterProps["onOpenThread"];
  readonly projectNames: ReadonlyMap<string, string>;
  readonly providerLabels: ReadonlyMap<string, string>;
}) {
  const [steerMessage, setSteerMessage] = useState("");
  const recovery = agentRunRecoveryLabel(props.summary.recoveryReason);
  return (
    <section aria-label="Agent run details" className="agents-center-detail">
      <header className="agents-center-detail__header">
        <h3 className="agents-center-detail__title">{props.summary.task}</h3>
        <OctantButton
          onClick={props.onBack}
          type="button"
          variant={props.narrow ? "secondary" : "ghost"}
        >
          {props.narrow ? "Back to list" : "Close details"}
        </OctantButton>
      </header>

      <p className="agents-center-detail__state">
        <span data-lifecycle={props.summary.lifecycleStatus}>
          {agentRunLifecycleLabel(props.summary.lifecycleStatus)}
        </span>
        <span>{agentRunAcknowledgementLabel(props.summary.resultAcknowledgement)}</span>
        <span>{agentRunUsageQualityLabel(props.summary.usageQuality)}</span>
      </p>
      {recovery === undefined ? null : (
        <p className="agents-center-detail__recovery" role="status">
          {recovery}
        </p>
      )}

      <div className="agents-center-detail__actions">
        <OctantButton
          onClick={() =>
            props.onOpenThread?.({
              ...agentRunCenterThreadTarget(props.summary),
              title: props.summary.parentThreadTitle,
            })
          }
          type="button"
          variant="secondary"
        >
          Open thread
        </OctantButton>
        <OctantButton
          onClick={() =>
            void props.controls.cancel({ runId: String(props.summary.runId) }).then((message) => {
              if (message !== undefined) props.controller.setNotice(message);
            })
          }
          type="button"
          variant="secondary"
        >
          Stop subtree
        </OctantButton>
        {props.summary.resultAcknowledgement.required &&
        !props.summary.resultAcknowledgement.acknowledged ? (
          <OctantButton
            onClick={() =>
              void props.controls
                .acknowledge({
                  runId: String(props.summary.runId),
                  version: props.summary.version,
                })
                .then((message) => {
                  if (message !== undefined) props.controller.setNotice(message);
                })
            }
            type="button"
            variant="secondary"
          >
            Acknowledge
          </OctantButton>
        ) : null}
        <OctantButton
          onClick={() =>
            void props.controls
              .retry({ runId: String(props.summary.runId), version: props.summary.version })
              .then((message) => {
                if (message !== undefined) props.controller.setNotice(message);
              })
          }
          type="button"
          variant="secondary"
        >
          Retry
        </OctantButton>
        <OctantButton
          onClick={() =>
            void props.controls
              .resume({ runId: String(props.summary.runId), version: props.summary.version })
              .then((message) => {
                if (message !== undefined) props.controller.setNotice(message);
              })
          }
          type="button"
          variant="secondary"
        >
          Resume
        </OctantButton>
      </div>

      <label className="agents-center-detail__steer">
        <span>Steer message</span>
        <OctantInput
          onChange={(event) => setSteerMessage(event.target.value)}
          value={steerMessage}
        />
        <OctantButton
          onClick={() =>
            void props.controls
              .steer({
                runId: String(props.summary.runId),
                version: props.summary.version,
                message: steerMessage,
              })
              .then((message) => {
                if (message !== undefined) props.controller.setNotice(message);
              })
          }
          type="button"
          variant="secondary"
        >
          Steer
        </OctantButton>
      </label>

      <dl className="agents-center-detail__facts">
        <div>
          <dt>Parent thread</dt>
          <dd>{props.summary.parentThreadTitle}</dd>
        </div>
        <div>
          <dt>Mode</dt>
          <dd>{agentRunModeLabel(props.summary.mode)}</dd>
        </div>
        <div>
          <dt>Project</dt>
          <dd>
            {props.summary.projectId === undefined
              ? "No Project"
              : (props.projectNames.get(String(props.summary.projectId)) ?? "Project")}
          </dd>
        </div>
        <div>
          <dt>Provider / model</dt>
          <dd>
            {props.providerLabels.get(String(props.summary.route.requestedProviderInstanceId)) ??
              String(props.summary.route.requestedProviderInstanceId)}{" "}
            · {agentRunRouteLabel(props.summary)}
          </dd>
        </div>
        <div>
          <dt>Workspace</dt>
          <dd>{agentRunWorkspaceLabel(props.summary.workspaceKind)}</dd>
        </div>
        <div>
          <dt>Authority</dt>
          <dd>{agentRunAuthoritySummary(props.summary.authority)}</dd>
        </div>
        <div>
          <dt>Role</dt>
          <dd>{props.summary.role}</dd>
        </div>
      </dl>
    </section>
  );
}
