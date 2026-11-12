import { useThreadControlNavigation } from "../composer/threadControlNavigation";
import { useThreadInfoPanel } from "../composer/ThreadInfo";
import type { ContextClient } from "@octant/client-runtime/context-client";
import type {
  ContextSubjectRef,
  PermissionMode,
  TaskAccessSnapshot,
  TaskAccessRecovery,
} from "@octant/contracts";
import { ChevronRight } from "lucide-react";
import { createContext, useContext, useEffect, useRef, useState } from "react";
import { OctantAlert } from "../ui/base/OctantAlert";
import { absoluteTimeFormatter } from "../lib/relativeTime";
import { OctantButton } from "../ui/base/OctantButton";
import { PERMISSION_MODE_LABEL } from "./PermissionModePicker";

export interface TaskAccessContextValue {
  readonly client: ContextClient;
  readonly subject: ContextSubjectRef;
  readonly onOpenProviders?: () => void;
  readonly onOpenAccess?: () => void;
  readonly onOpenProtectedFiles?: () => void;
}
export const TaskAccessContext = createContext<TaskAccessContextValue | undefined>(undefined);

/** A report belongs to the exact client/task/version that requested it. */
export function useTaskAccessFacts(
  mode: PermissionMode,
  version: number | undefined,
  activity: string | undefined,
) {
  const context = useContext(TaskAccessContext);
  const reader = context?.client;
  const key =
    context === undefined
      ? ""
      : `${context.subject.aggregateType}:${context.subject.aggregateId}:${mode}:${version ?? ""}:${activity ?? ""}`;
  const [revision, refresh] = useState(0);
  const [state, setState] = useState<{
    readonly reader: ContextClient | undefined;
    readonly key: string;
    readonly status: "loading" | "ready" | "unavailable";
    readonly facts?: TaskAccessSnapshot;
  }>();
  const current = useRef({ reader, key });
  current.current = { reader, key };
  useEffect(() => {
    if (context === undefined || reader?.taskAccess === undefined) return;
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]);
    const stillCurrent = () =>
      !controller.signal.aborted &&
      current.current.reader === reader &&
      current.current.key === key;
    setState({ reader, key, status: "loading" });
    reader
      .taskAccess(context.subject, signal)
      .then((facts) => {
        if (!stillCurrent()) return;
        if (
          String(facts.subject.aggregateId) !== String(context.subject.aggregateId) ||
          facts.subject.aggregateType !== context.subject.aggregateType
        ) {
          setState({ reader, key, status: "unavailable" });
          return;
        }
        setState({ reader, key, status: "ready", facts });
      })
      .catch(() => {
        if (stillCurrent()) setState({ reader, key, status: "unavailable" });
      });
    return () => controller.abort();
  }, [reader, key, revision]);
  const matching = state?.reader === reader && state?.key === key ? state : undefined;
  return {
    context,
    facts: matching?.facts,
    status: matching?.status ?? "unavailable",
    refresh: () => refresh((value) => value + 1),
  };
}

type AccessRead = ReturnType<typeof useTaskAccessFacts>;
const REVIEWER = {
  person: "You",
  provider: "Provider's own reviewer",
  "octant-shield": "Octant Shield",
  none: "No approval prompts",
  unknown: "Not reported",
} as const;
const CAPABILITY = {
  approvals: "Approval requests",
  appManagedTools: "Octant-managed tools",
  nativeWebResearch: "Runtime web research",
  nativeChildAgents: "Runtime child agents",
  forceStop: "Force Stop",
} as const;

/** Expands the existing indicator; every recovery uses an existing person action. */
export function TaskAccessDetails({ read }: { readonly read: AccessRead }) {
  const [open, setOpen] = useState(false);
  const infoPanel = useThreadInfoPanel();
  useThreadControlNavigation(
    read.context === undefined ? undefined : String(read.context.subject.aggregateId),
    "access",
    () => {
      read.refresh();
      // The details live in the thread's info panel, which may be closed.
      infoPanel?.open();
      setOpen(true);
    },
  );
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLElement>(null);
  const { facts, context } = read;
  useEffect(() => {
    if (open) panel.current?.focus();
  }, [open]);
  const close = () => {
    setOpen(false);
    trigger.current?.focus();
  };
  const local = context?.client.externalContentAvailable === true;
  const recover = (recovery: TaskAccessRecovery) =>
    recovery === "provider-settings"
      ? context?.onOpenProviders
      : recovery === "access-settings"
        ? context?.onOpenAccess
        : undefined;
  return (
    <div className="task-access-details text-sm text-muted-foreground">
      <OctantButton
        ref={trigger}
        aria-expanded={open}
        onClick={() => {
          if (!open) read.refresh();
          setOpen((value) => !value);
        }}
        type="button"
        size="sm"
        variant="ghost"
      >
        Access details
        <ChevronRight aria-hidden="true" size={12} />
      </OctantButton>
      {open ? (
        <section
          ref={panel}
          tabIndex={-1}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              close();
            }
          }}
          aria-label="Task access details"
          className="task-access-details__report flex max-h-[min(50vh,30rem)] min-w-0 flex-col gap-2 overflow-y-auto overscroll-contain"
        >
          <p>
            These are the host&apos;s reported limits. Every action is checked again when it runs.
          </p>
          {read.status === "loading" ? (
            <p role="status">Reading task access from the host…</p>
          ) : facts === undefined ? (
            <OctantAlert tone="warning">
              The host has not reported current task access. Reconnect or refresh before relying on
              a previous report.
            </OctantAlert>
          ) : (
            <>
              <dl className="task-access-details__facts">
                <dt>Task state</dt>
                <dd>
                  {facts.standing === "active"
                    ? "Active"
                    : facts.standing === "completed"
                      ? "Done; reopen before another turn"
                      : "Inactive; restore before another turn"}
                </dd>
                <dt>Selected level</dt>
                <dd>{PERMISSION_MODE_LABEL[facts.selectedMode]}</dd>
                <dt>Effective level</dt>
                <dd>
                  {facts.effectiveMode === undefined
                    ? "Not reported"
                    : PERMISSION_MODE_LABEL[facts.effectiveMode]}
                </dd>
                <dt>Current default</dt>
                <dd>
                  {facts.default.status === "unknown"
                    ? "Not reported"
                    : `${PERMISSION_MODE_LABEL[facts.default.mode]} · ${facts.default.scope === "project" ? "Project" : "global"} default${facts.default.matchesSelected ? " (matches the selected level)" : " (differs from the selected level)"}`}
                </dd>
                <dt>Current turn/session limit</dt>
                <dd>
                  {facts.ceiling === undefined
                    ? "No narrower limit reported"
                    : PERMISSION_MODE_LABEL[facts.ceiling]}
                </dd>
                <dt>Reviewer route</dt>
                <dd>
                  {REVIEWER[facts.reviewer.kind]}
                  {facts.reviewer.availability === "unavailable"
                    ? facts.reviewer.kind === "octant-shield"
                      ? " · unavailable; asks you"
                      : " · unavailable"
                    : facts.reviewer.availability === "unknown"
                      ? " · availability not reported"
                      : ""}
                </dd>
                <dt>Reviewer account</dt>
                <dd className="break-words">
                  {facts.reviewer.accountName ??
                    (facts.reviewer.kind === "person" || facts.reviewer.kind === "none"
                      ? "Not applicable"
                      : "Not reported")}
                </dd>
                <dt>Reviewer model</dt>
                <dd className="break-words">
                  {facts.reviewer.modelId ??
                    (facts.reviewer.kind === "person" || facts.reviewer.kind === "none"
                      ? "Not applicable"
                      : "Not reported")}
                </dd>
                <dt>Runtime observation</dt>
                <dd>
                  {facts.runtime.observedAt === undefined
                    ? "Not reported"
                    : absoluteTimeFormatter.format(new Date(facts.runtime.observedAt))}
                </dd>
                <dt>Selected runtime account</dt>
                <dd className="break-words">
                  {facts.runtime.accountName ?? "Not reported"} · {facts.runtime.modelId} ·{" "}
                  {facts.runtime.enabled === false
                    ? "turned off"
                    : (facts.runtime.readiness ?? "readiness not reported")}
                </dd>
              </dl>
              {facts.runtime.capabilities.length === 0 ? (
                <p>Runtime capabilities have not been reported.</p>
              ) : (
                <ul>
                  {facts.runtime.capabilities.map((capability) => (
                    <li key={capability.id}>
                      {CAPABILITY[capability.id]}:{" "}
                      {capability.support === "supported"
                        ? "supported"
                        : capability.support === "mixed"
                          ? "mixed with tools Octant did not supply"
                          : capability.support === "unsupported"
                            ? "unsupported by this runtime"
                            : "temporarily unavailable"}
                    </li>
                  ))}
                </ul>
              )}
              {facts.outsideContent.read ? (
                <p>
                  {facts.outsideContent.effect === "recorded"
                    ? "Outside content is recorded at Full access; the mark does not add approval prompts."
                    : facts.outsideContent.effect === "gates"
                      ? "This task read outside content, so some actions ask each time. Review the existing outside-content notice above the composer when the task is idle."
                      : "This task read outside content. Its current effect has not been reported."}
                </p>
              ) : null}
              <ul>
                {facts.limitations.map((limit, index) => (
                  <li key={`${limit.kind}:${index}`} className="flex flex-wrap items-center gap-2">
                    <span>{limit.message}</span>
                    {limit.recovery === "none" ? null : local &&
                      recover(limit.recovery) !== undefined ? (
                      <OctantButton
                        type="button"
                        size="sm"
                        variant="outline"
                        onClick={recover(limit.recovery)}
                      >
                        {limit.recovery === "provider-settings"
                          ? "Open provider settings"
                          : "Open reviewer settings"}
                      </OctantButton>
                    ) : (
                      <span>Ask the host owner to make this change.</span>
                    )}
                  </li>
                ))}
              </ul>
              <p>
                Octant&apos;s direct file tools refuse protected files at every level. Below Full
                access, commands are confined too. Use the permitted credential channel; changing
                tools is not a remedy for a refused file read.
              </p>
              {local && context?.onOpenProtectedFiles !== undefined ? (
                <OctantButton
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={context.onOpenProtectedFiles}
                >
                  Protected file guidance
                </OctantButton>
              ) : null}
              {facts.browser?.status === "omitted" &&
              facts.browser.reason === "excluded-by-thread-constraints" ? (
                <p>
                  This task's saved tool constraints exclude Browser. Changing its access level does
                  not remove those constraints. Start a task with a profile that permits Browser.
                </p>
              ) : null}
              <p className="text-xs">
                Reported {absoluteTimeFormatter.format(new Date(facts.observedAt))}. Current
                defaults do not prove which setting originally created this task.
              </p>
            </>
          )}
          <div className="task-access-details__actions">
            <OctantButton type="button" size="sm" variant="ghost" onClick={close}>
              Close access details
            </OctantButton>
            <OctantButton type="button" size="sm" variant="outline" onClick={read.refresh}>
              Refresh access report
            </OctantButton>
          </div>
        </section>
      ) : null}
    </div>
  );
}
