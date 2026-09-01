import { ChatClientFailure, type ChatClient } from "@octant/client-runtime/chat-client";
import { ProjectClientFailure, type ProjectClient } from "@octant/client-runtime/project-client";
import type { ProjectId } from "@octant/contracts/projects";
import type { ProviderInstanceId, ProviderModelId } from "@octant/contracts/providers";
import type { ModelPickerSelection, PickerGroup } from "@octant/domain";
import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from "react";
import { ComposerModelPicker } from "../providers/ComposerModelPicker";
import { ThreadComposer } from "../composer/ThreadComposer";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantTextarea } from "../ui/base/OctantTextarea";
import type { ChatController } from "./useChatController";

export type ChatOverviewSectionStatus =
  | "loading"
  | "empty"
  | "unavailable"
  | "unauthorized"
  | "stale"
  | "failure"
  | "ready";

export interface ChatOverviewItem {
  readonly id: string;
  readonly label: string;
  readonly detail?: string;
}

type ChatOverviewCompletePath = "project-memory" | "project-threads";

export interface ChatOverviewSection {
  readonly status: ChatOverviewSectionStatus;
  readonly message?: string;
  readonly items?: ReadonlyArray<ChatOverviewItem>;
  readonly archivedItems?: ReadonlyArray<ChatOverviewItem>;
  /** A bounded overview must name the authoritative path to omitted items. */
  readonly notice?: string;
  /** The complete source behind a compact section, when its item bound applies. */
  readonly completePath?: ChatOverviewCompletePath;
}

export interface ChatProjectOverviewModel {
  readonly attachmentsAndContext: ChatOverviewSection;
  readonly memory: ChatOverviewSection;
  readonly outcomesAndDecisions: ChatOverviewSection;
  readonly threads: ChatOverviewSection;
  readonly unfinishedWork: ChatOverviewSection;
}

export interface ChatProjectOverviewProps {
  readonly client?: ChatClient;
  readonly controller?: ChatController;
  readonly model?: ChatProjectOverviewModel;
  readonly onCreateThread?: (draft: string) => boolean | Promise<boolean>;
  readonly onOpenThread?: (threadId: string) => void;
  readonly onViewAllProjectThreads?: () => void;
  readonly onOpenSettings?: () => void;
  readonly onSelectProvider?: (selection: ModelPickerSelection) => void;
  readonly projectClient?: ProjectClient;
  readonly projectId?: ProjectId;
  /** Advances after an authoritative Project-memory mutation or reload. */
  readonly memoryRevision?: number;
  readonly providerGroups?: ReadonlyArray<PickerGroup>;
  readonly selectedModelId?: ProviderModelId;
  readonly selectedProviderInstanceId?: ProviderInstanceId;
}

const OVERVIEW_THREAD_LIMIT = 8;

const SECTIONS: ReadonlyArray<readonly [keyof ChatProjectOverviewModel, string]> = [
  ["threads", "Active threads"],
  ["unfinishedWork", "Unfinished work and follow-up"],
  ["memory", "Approved memory"],
  ["attachmentsAndContext", "Attachments and pinned context"],
  ["outcomesAndDecisions", "Outcomes and decisions"],
];

function isVisibleOverviewSection(section: ChatOverviewSection): boolean {
  if (section.status === "empty") return false;
  if (
    section.status === "ready" &&
    (section.items === undefined || section.items.length === 0) &&
    (section.archivedItems === undefined || section.archivedItems.length === 0) &&
    section.notice === undefined &&
    section.completePath === undefined
  ) {
    return false;
  }
  return true;
}

export function ChatProjectOverview(props: ChatProjectOverviewProps) {
  const loadedModel = useChatProjectOverviewModel(props);
  const model = props.model ?? loadedModel;
  const input = useRef<HTMLTextAreaElement>(null);
  const inputId = useId();
  const [draft, setDraft] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [restoreFocus, setRestoreFocus] = useState(false);
  const createAvailable = props.onCreateThread !== undefined;
  const visibleSections = SECTIONS.filter(([key]) => isVisibleOverviewSection(model[key]));
  const homeOnly = visibleSections.length === 0;

  useEffect(() => {
    if (!restoreFocus || submitting) return;
    input.current?.focus();
    setRestoreFocus(false);
  }, [restoreFocus, submitting]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const normalized = draft.trim();
    if (!createAvailable || submitting || normalized === "") return;
    setSubmitting(true);
    try {
      const created = await props.onCreateThread(normalized);
      if (created) setDraft("");
      else setRestoreFocus(true);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section
      aria-label="Chat Project Overview"
      className={
        homeOnly ? "chat-project-overview chat-project-overview--home" : "chat-project-overview"
      }
    >
      <section aria-label="Chat quick start" className="chat-project-overview__quick-start">
        <h2>Start the next Chat in this Project</h2>
        <p className="chat-project-overview__scope">
          Starts an ordinary Chat thread in this Project.
        </p>
        {!createAvailable ? (
          <p role="status">Chat thread creation is unavailable for this Project.</p>
        ) : null}
        <form noValidate onSubmit={(event) => void submit(event)}>
          <label className="sr-only" htmlFor={inputId}>
            Start a new Chat thread
          </label>
          <ThreadComposer
            input={
              <OctantTextarea
                className="composer-input"
                disabled={!createAvailable || submitting}
                id={inputId}
                onChange={(event) => setDraft(event.target.value)}
                placeholder="Describe the next Chat thread…"
                ref={input}
                rows={3}
                value={draft}
              />
            }
            row={{
              leading: (
                <ComposerModelPicker
                  ariaLabel="Provider and model"
                  disabled={!createAvailable || submitting}
                  groups={props.providerGroups ?? []}
                  menuSide="bottom"
                  onSelect={props.onSelectProvider ?? (() => undefined)}
                  {...(props.onOpenSettings === undefined
                    ? {}
                    : { onOpenSettings: props.onOpenSettings })}
                  {...(props.selectedModelId === undefined
                    ? {}
                    : { selectedModelId: props.selectedModelId })}
                  {...(props.selectedProviderInstanceId === undefined
                    ? {}
                    : {
                        selectedProviderInstanceId: props.selectedProviderInstanceId,
                      })}
                />
              ),
              actions: {
                kind: "send",
                send: {
                  ariaLabel: "Start thread",
                  disabled: !createAvailable || submitting || draft.trim() === "",
                },
              },
            }}
          />
        </form>
      </section>
      {visibleSections.length === 0 ? null : (
        <div className="chat-project-overview__sections">
          {visibleSections.map(([key, title]) => (
            <OverviewSection
              key={key}
              {...(key === "threads" &&
              model[key].status === "ready" &&
              props.onOpenThread !== undefined
                ? { onOpenItem: props.onOpenThread }
                : {})}
              {...(model[key].completePath === "project-threads" &&
              props.onViewAllProjectThreads !== undefined
                ? { onViewAllProjectThreads: props.onViewAllProjectThreads }
                : {})}
              {...(props.projectId === undefined ? {} : { projectId: props.projectId })}
              section={model[key]}
              title={title}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function useChatProjectOverviewModel(props: ChatProjectOverviewProps): ChatProjectOverviewModel {
  const [model, setModel] = useState<ChatProjectOverviewModel>(() => props.model ?? loadingModel());

  useEffect(() => {
    if (props.model !== undefined) {
      setModel(props.model);
      return;
    }
    if (
      props.client === undefined ||
      props.controller === undefined ||
      props.projectId === undefined
    ) {
      setModel(loadingModel());
      return;
    }
    if (props.controller.bootstrap === undefined) {
      setModel(
        props.controller.status === "disconnected"
          ? unavailableModel("Chat data is unavailable while the connection is offline.")
          : loadingModel(),
      );
      return;
    }
    if (props.controller.status !== "ready") {
      setModel((current) =>
        staleModel(current, "Chat data may be out of date while the connection is offline."),
      );
      return;
    }
    let live = true;
    const projectThreads = props.controller.bootstrap.threads.filter(
      (thread) => String(thread.projectId ?? "") === String(props.projectId),
    );
    const activeThreads = projectThreads.filter(
      (thread) => thread.lifecycle === "active" || thread.lifecycle === undefined,
    );
    const archivedThreads = projectThreads.filter((thread) => thread.lifecycle === "archived");
    const overviewThreads = activeThreads.slice(0, OVERVIEW_THREAD_LIMIT);
    const activeSection = boundedSection(
      activeThreads.map((thread) => ({
        id: String(thread.id),
        label: thread.title,
        detail: "Active",
      })),
      "No Chat threads in this Project yet.",
      "Project threads",
      "project-threads",
    );
    const archivedItems =
      archivedThreads.length === 0
        ? undefined
        : archivedThreads.map((thread) => ({
            id: String(thread.id),
            label: thread.title,
            detail: "Archived",
          }));
    const threads =
      archivedItems === undefined
        ? activeSection
        : {
            ...activeSection,
            status: activeSection.status === "empty" ? "ready" : activeSection.status,
            ...(activeSection.status === "empty"
              ? { message: "No active Chat threads in this Project." }
              : {}),
            archivedItems,
          };
    const unqueriedThreadsNotice =
      activeThreads.length > overviewThreads.length
        ? `${activeThreads.length - overviewThreads.length} additional Project thread${activeThreads.length - overviewThreads.length === 1 ? " is" : "s are"} outside this compact Overview.`
        : undefined;
    setModel({
      attachmentsAndContext: loadingSection(),
      memory: loadingSection(),
      outcomesAndDecisions: loadingSection(),
      threads,
      unfinishedWork: loadingSection(),
    });

    void Promise.allSettled(overviewThreads.map((thread) => props.client!.thread(thread.id))).then(
      (views) => {
        if (!live) return;
        if (views.some((result) => isUnauthorizedChatFailure(result))) {
          setModel((current) => ({
            ...current,
            attachmentsAndContext: unauthorizedSection(
              "Attachments and pinned context are unauthorized.",
            ),
            threads: unauthorizedSection("Project threads are unauthorized."),
            unfinishedWork: unauthorizedSection("Unfinished work and follow-up are unauthorized."),
          }));
          return;
        }
        const fulfilledViews = views.flatMap((result) =>
          result.status === "fulfilled" ? [result.value] : [],
        );
        const viewsUnavailable = overviewThreads.length > 0 && fulfilledViews.length === 0;
        const viewsIncomplete = fulfilledViews.length !== overviewThreads.length;
        const viewsFailure = (available: string, incomplete: string) =>
          viewsUnavailable
            ? unavailableSection(available)
            : viewsIncomplete
              ? staleSection(incomplete)
              : undefined;
        const attachments = fulfilledViews
          .flatMap((view) => view.attachments)
          .filter((attachment) => attachment.status !== "purged")
          .map((attachment) => ({
            id: String(attachment.id),
            label: attachment.displayName,
            detail: attachment.status,
          }));
        const unfinished = fulfilledViews.flatMap((view) => [
          ...view.workItems
            .filter((item) => item.status !== "completed" && item.status !== "cancelled")
            .map((item) => ({
              id: String(item.id),
              label: item.title,
              detail: item.status,
            })),
          ...(view.followUp?.state === "open"
            ? [
                {
                  id: `follow-up-${view.thread.id}`,
                  label: view.followUp.reason,
                  detail: "Follow-up",
                },
              ]
            : []),
        ]);
        setModel((current) => ({
          ...current,
          attachmentsAndContext:
            viewsFailure(
              "Attachments and pinned context are unavailable.",
              "Some attachments and pinned context may be out of date.",
            ) ??
            boundedSection(
              attachments,
              "No attachments or pinned context in this Project yet.",
              "attachments and pinned context items",
              "project-threads",
              unqueriedThreadsNotice,
            ),
          unfinishedWork:
            viewsFailure(
              "Unfinished work and follow-up are unavailable.",
              "Some unfinished work and follow-up may be out of date.",
            ) ??
            boundedSection(
              unfinished,
              "No unfinished work or follow-up in this Project.",
              "unfinished work and follow-up items",
              "project-threads",
              unqueriedThreadsNotice,
            ),
        }));
      },
    );
    const memory =
      props.projectClient === undefined
        ? Promise.reject(
            new ProjectClientFailure({
              category: "unavailable",
              message: "Project memory is unavailable.",
            }),
          )
        : Promise.resolve().then(() => props.projectClient!.memory(props.projectId!));
    void memory.then(
      (value) => {
        if (!live) return;
        const entries = value.active.map((entry) => ({
          id: String(entry.id),
          label: entry.content,
          detail: entry.kind,
        }));
        const outcomes = value.active
          .filter((entry) => entry.kind === "decision" || entry.kind === "outcome")
          .map((entry) => ({
            id: String(entry.id),
            label: entry.content,
            detail: `Approved ${entry.kind}`,
          }));
        setModel((current) => ({
          ...current,
          memory: boundedSection(
            entries,
            "No approved Project memory yet.",
            "approved Project memory entries",
            "project-memory",
          ),
          outcomesAndDecisions: boundedSection(
            outcomes,
            "No provenance-backed outcomes or decisions yet.",
            "outcomes and decisions",
            "project-memory",
          ),
        }));
      },
      (reason: unknown) => {
        if (!live) return;
        setModel((current) => ({
          ...current,
          memory: memoryFailureSection(reason, "Approved Project memory"),
          outcomesAndDecisions: memoryFailureSection(reason, "Outcomes and decisions"),
        }));
      },
    );
    return () => {
      live = false;
    };
  }, [
    props.client,
    props.controller?.bootstrap,
    props.controller?.navigation,
    props.controller?.status,
    props.memoryRevision,
    props.model,
    props.projectClient,
    props.projectId,
  ]);

  return model;
}

function OverviewSection(props: {
  readonly onOpenItem?: (itemId: string) => void;
  readonly onViewAllProjectThreads?: () => void;
  readonly projectId?: ProjectId;
  readonly section: ChatOverviewSection;
  readonly title: string;
}) {
  return (
    <section aria-label={props.title} className="chat-project-overview__section">
      <h2>{props.title}</h2>
      <SectionBody
        {...(props.onOpenItem === undefined ? {} : { onOpenItem: props.onOpenItem })}
        {...(props.onViewAllProjectThreads === undefined
          ? {}
          : { onViewAllProjectThreads: props.onViewAllProjectThreads })}
        {...(props.projectId === undefined ? {} : { projectId: props.projectId })}
        section={props.section}
      />
    </section>
  );
}

function OverviewItemList(props: {
  readonly items: ReadonlyArray<ChatOverviewItem>;
  readonly onOpenItem?: (itemId: string) => void;
}) {
  return (
    <ul className="chat-project-overview__items">
      {props.items.map((item) => (
        <li key={item.id}>
          {props.onOpenItem === undefined ? (
            <>
              <span>{item.label}</span>
              {item.detail === undefined ? null : <span>{item.detail}</span>}
            </>
          ) : (
            <OctantButton
              className="project-button project-button--quiet"
              onClick={() => props.onOpenItem?.(item.id)}
              type="button"
              variant="ghost"
            >
              <span>{item.label}</span>
              {item.detail === undefined ? null : <span>{item.detail}</span>}
            </OctantButton>
          )}
        </li>
      ))}
    </ul>
  );
}

function ArchivedThreadDisclosure(props: {
  readonly items: ReadonlyArray<ChatOverviewItem>;
  readonly onOpenItem?: (itemId: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const count = props.items.length;
  if (count === 0) return null;
  return (
    <div className="chat-project-overview__archived">
      <OctantButton
        aria-expanded={expanded}
        className="project-button project-button--quiet"
        onClick={() => setExpanded((current) => !current)}
        type="button"
        variant="ghost"
      >
        {expanded ? "Hide archived threads" : `Show archived threads (${count})`}
      </OctantButton>
      {expanded ? (
        <OverviewItemList
          items={props.items}
          {...(props.onOpenItem === undefined ? {} : { onOpenItem: props.onOpenItem })}
        />
      ) : null}
    </div>
  );
}

function SectionBody(props: {
  readonly onOpenItem?: (itemId: string) => void;
  readonly onViewAllProjectThreads?: () => void;
  readonly projectId?: ProjectId;
  readonly section: ChatOverviewSection;
}): ReactNode {
  const message = props.section.message ?? defaultMessage(props.section.status);
  if (props.section.status === "ready" || props.section.status === "stale") {
    const items = props.section.items ?? [];
    const archivedItems = props.section.archivedItems ?? [];
    return (
      <>
        {items.length === 0 ? (
          archivedItems.length === 0 ? (
            <p role="status">{props.section.message ?? "Nothing to show yet."}</p>
          ) : (
            <p role="status">No active Chat threads in this Project.</p>
          )
        ) : (
          <OverviewItemList
            items={items}
            {...(props.onOpenItem === undefined ? {} : { onOpenItem: props.onOpenItem })}
          />
        )}
        <ArchivedThreadDisclosure
          items={archivedItems}
          {...(props.onOpenItem === undefined ? {} : { onOpenItem: props.onOpenItem })}
        />
        {props.section.notice === undefined ? null : <p role="status">{props.section.notice}</p>}
        {props.section.completePath === "project-threads" &&
        props.onViewAllProjectThreads !== undefined ? (
          <OctantButton
            className="project-button project-button--quiet"
            onClick={props.onViewAllProjectThreads}
            type="button"
            variant="ghost"
          >
            View all Project threads
          </OctantButton>
        ) : null}
        {props.section.status === "stale" && items.length > 0 ? (
          <p role="status">{message}</p>
        ) : null}
      </>
    );
  }
  const role =
    props.section.status === "loading" || props.section.status === "empty" ? "status" : "alert";
  return <p role={role}>{message}</p>;
}

function sectionFromItems(
  items: ReadonlyArray<ChatOverviewItem>,
  empty: string,
): ChatOverviewSection {
  return items.length === 0 ? { status: "empty", message: empty } : { status: "ready", items };
}

function unavailableSection(message: string): ChatOverviewSection {
  return { status: "unavailable", message };
}

function unauthorizedSection(message: string): ChatOverviewSection {
  return { status: "unauthorized", message };
}

function isUnauthorizedChatFailure(
  result: PromiseSettledResult<unknown>,
): result is PromiseRejectedResult {
  return (
    result.status === "rejected" &&
    result.reason instanceof ChatClientFailure &&
    result.reason.category === "unauthorized"
  );
}

function staleSection(message: string): ChatOverviewSection {
  return { status: "stale", message };
}

function loadingSection(): ChatOverviewSection {
  return { status: "loading", message: "Loading…" };
}

function boundedSection(
  items: ReadonlyArray<ChatOverviewItem>,
  empty: string,
  itemLabel: string,
  completePath: ChatOverviewCompletePath,
  sourceScopeNotice?: string,
): ChatOverviewSection {
  const visible = items.slice(0, OVERVIEW_THREAD_LIMIT);
  const countNotice =
    visible.length < items.length
      ? `Showing ${visible.length} of ${items.length} ${itemLabel}.`
      : undefined;
  const notice = [countNotice, sourceScopeNotice]
    .filter((value): value is string => value !== undefined)
    .join(" ");
  if (notice === "") return sectionFromItems(visible, empty);
  return {
    ...(visible.length === 0
      ? { items: visible, message: empty, status: "ready" as const }
      : { items: visible, status: "ready" as const }),
    completePath,
    notice,
  };
}

function memoryFailureSection(reason: unknown, subject: string): ChatOverviewSection {
  const verb = subject === "Outcomes and decisions" ? "are" : "is";
  if (reason instanceof ProjectClientFailure) {
    if (reason.category === "unauthorized") {
      return {
        status: "unauthorized",
        message: `${subject} ${verb} unauthorized.`,
      };
    }
    if (reason.category === "unavailable") {
      return {
        status: "unavailable",
        message: `${subject} ${verb} unavailable.`,
      };
    }
  }
  return { status: "failure", message: `${subject} could not be loaded.` };
}

function loadingModel(): ChatProjectOverviewModel {
  const loading = loadingSection();
  return {
    attachmentsAndContext: loading,
    memory: loading,
    outcomesAndDecisions: loading,
    threads: loading,
    unfinishedWork: loading,
  };
}

function unavailableModel(message: string): ChatProjectOverviewModel {
  const unavailable = unavailableSection(message);
  return {
    attachmentsAndContext: unavailable,
    memory: unavailable,
    outcomesAndDecisions: unavailable,
    threads: unavailable,
    unfinishedWork: unavailable,
  };
}

function staleModel(model: ChatProjectOverviewModel, message: string): ChatProjectOverviewModel {
  return {
    attachmentsAndContext: {
      ...model.attachmentsAndContext,
      status: "stale",
      message,
    },
    memory: { ...model.memory, status: "stale", message },
    outcomesAndDecisions: {
      ...model.outcomesAndDecisions,
      status: "stale",
      message,
    },
    threads: { ...model.threads, status: "stale", message },
    unfinishedWork: { ...model.unfinishedWork, status: "stale", message },
  };
}

function defaultMessage(status: ChatOverviewSectionStatus): string {
  switch (status) {
    case "loading":
      return "Loading…";
    case "empty":
      return "Nothing to show yet.";
    case "unavailable":
      return "Unavailable.";
    case "unauthorized":
      return "Unauthorized.";
    case "stale":
      return "May be out of date.";
    case "failure":
      return "Could not be loaded.";
    case "ready":
      return "";
  }
}
