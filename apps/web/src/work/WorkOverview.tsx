import type { ProviderInstanceId, ProviderModelId } from "@octant/contracts";
import type { CreateHostViewScope, PickerGroup, ModelPickerSelection } from "@octant/domain";
import { FolderOpen, ShieldCheck } from "lucide-react";
import { useState, type FormEvent, type ReactNode } from "react";
import { HostSelector } from "../shell/HostSelector";
import type { HostId, HostIdentity } from "@octant/contracts/host";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantInput } from "../ui/base/OctantInput";
import { OctantNativeSelect } from "../ui/base/OctantSelect";
import { OctantTextarea } from "../ui/base/OctantTextarea";
import { ComposerModelPicker } from "../providers/ComposerModelPicker";

export type OverviewSectionStatus =
  | "loading"
  | "ready"
  | "empty"
  | "unavailable"
  | "unauthorized"
  | "stale"
  | "failure";

export interface WorkOverviewItem {
  readonly id: string;
  readonly label: string;
  readonly detail?: string;
}

export interface WorkOverviewSectionModel {
  readonly status: OverviewSectionStatus;
  readonly message?: string;
  readonly items?: ReadonlyArray<WorkOverviewItem>;
}

export interface WorkOverviewModel {
  readonly filesAndArtifacts: WorkOverviewSectionModel;
  readonly workflowsAndThreads: WorkOverviewSectionModel;
  readonly approvals: WorkOverviewSectionModel;
  readonly versions: WorkOverviewSectionModel;
  readonly validation: WorkOverviewSectionModel;
  readonly exports: WorkOverviewSectionModel;
}

export interface WorkOverviewProps {
  /** Authoritative research provenance surface, composed by the workspace. */
  readonly research?: ReactNode;
  readonly createStarterArtifactAvailable?: boolean;
  readonly createThreadAvailable?: boolean;
  readonly hosts?: ReadonlyArray<HostIdentity>;
  readonly selectedHostId?: HostId;
  readonly fixedHostId?: HostId;
  readonly lastSelectedHealthyHostId?: HostId;
  readonly viewScope?: CreateHostViewScope;
  readonly onSelectHost?: (hostId: HostId) => void;
  readonly model: WorkOverviewModel;
  readonly onSelectProvider?: (selection: ModelPickerSelection) => void;
  readonly onCreateStarterArtifact?: (draft: {
    readonly content: string;
    readonly displayName: string;
    readonly format: "markdown";
  }) => boolean | Promise<boolean>;
  readonly onCreateThread: (draft: string) => boolean | Promise<boolean>;
  readonly onOpenThread?: (threadId: string) => void;
  readonly onOpenSettings?: () => void;
  readonly projectName?: string;
  readonly providerGroups?: ReadonlyArray<PickerGroup>;
  readonly selectedModelId?: ProviderModelId;
  readonly selectedProviderInstanceId?: ProviderInstanceId;
}

const SECTIONS = [
  { key: "filesAndArtifacts", title: "Recent files and artifacts" },
  { key: "workflowsAndThreads", title: "Active workflows and threads" },
  { key: "approvals", title: "Approvals" },
  { key: "versions", title: "Versions and recent changes" },
  { key: "validation", title: "Validation" },
  { key: "exports", title: "Exports and handoffs" },
] as const;

export function WorkOverview(props: WorkOverviewProps) {
  const createAvailable = props.createThreadAvailable !== false;
  const providerGroups = props.providerGroups ?? [];
  const hasSelectableProvider = providerGroups.some((group) =>
    group.sections.some((section) =>
      section.models.some((model) => model.unavailableReason === undefined),
    ),
  );
  const [draft, setDraft] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const createStarterArtifactAvailable =
    props.createStarterArtifactAvailable === true && props.onCreateStarterArtifact !== undefined;
  const [starterArtifactPath, setStarterArtifactPath] = useState("notes.md");
  const [starterArtifactContent, setStarterArtifactContent] = useState("");
  const [starterArtifactSubmitting, setStarterArtifactSubmitting] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const normalized = draft.trim();
    if (!createAvailable || submitting || normalized === "") return;
    setSubmitting(true);
    try {
      const created = await props.onCreateThread(normalized);
      if (created) setDraft("");
    } finally {
      setSubmitting(false);
    }
  }

  async function submitStarterArtifact(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const displayName = starterArtifactPath.trim();
    const content = starterArtifactContent.trim();
    if (
      !createStarterArtifactAvailable ||
      starterArtifactSubmitting ||
      displayName === "" ||
      content === ""
    ) {
      return;
    }
    setStarterArtifactSubmitting(true);
    try {
      const created = await props.onCreateStarterArtifact?.({
        format: "markdown",
        displayName,
        content,
      });
      if (created) {
        setStarterArtifactPath("notes.md");
        setStarterArtifactContent("");
      }
    } finally {
      setStarterArtifactSubmitting(false);
    }
  }

  return (
    <section aria-label="Work overview" className="project-overview work-overview">
      <div className="work-overview__sections">
        {SECTIONS.map((section) => {
          const onOpenItem =
            section.key === "workflowsAndThreads" && props.onOpenThread !== undefined
              ? (itemId: string) => {
                  props.onOpenThread?.(itemId);
                }
              : undefined;
          return (
            <OverviewSection
              key={section.key}
              {...(onOpenItem === undefined ? {} : { onOpenItem })}
              section={props.model[section.key]}
              title={section.title}
            />
          );
        })}
      </div>

      {props.research}

      <section aria-label="Work quick start" className="work-overview__composer">
        <div aria-label="Thread context" className="work-overview__context-strip">
          <HostSelector
            {...(props.hosts === undefined ? {} : { hosts: props.hosts })}
            {...(props.selectedHostId === undefined
              ? {}
              : { selectedHostId: props.selectedHostId })}
            {...(props.fixedHostId === undefined ? {} : { fixedHostId: props.fixedHostId })}
            {...(props.lastSelectedHealthyHostId === undefined
              ? {}
              : { lastSelectedHealthyHostId: props.lastSelectedHealthyHostId })}
            {...(props.viewScope === undefined ? {} : { viewScope: props.viewScope })}
            {...(props.onSelectHost === undefined ? {} : { onSelectHost: props.onSelectHost })}
            requiredCapability="work"
          />
          {props.projectName === undefined ? null : (
            <span className="work-overview__context-item">
              <FolderOpen aria-hidden="true" size={12} strokeWidth={1.8} />
              <span>{props.projectName}</span>
            </span>
          )}
          <span className="work-overview__context-item">
            <ShieldCheck aria-hidden="true" size={12} strokeWidth={1.8} />
            <span>Confined to this Project</span>
          </span>
          {props.onSelectProvider === undefined ? null : (
            <ComposerModelPicker
              ariaLabel="Provider and model"
              disabled={submitting || (hasSelectableProvider && !createAvailable)}
              groups={hasSelectableProvider ? providerGroups : []}
              {...(props.onOpenSettings === undefined
                ? {}
                : { onOpenSettings: props.onOpenSettings })}
              onSelect={props.onSelectProvider}
              {...(props.selectedModelId === undefined
                ? {}
                : { selectedModelId: props.selectedModelId })}
              {...(props.selectedProviderInstanceId === undefined
                ? {}
                : { selectedProviderInstanceId: props.selectedProviderInstanceId })}
            />
          )}
        </div>
        {!createAvailable ? (
          <p role="status">Thread creation is unavailable for this Project.</p>
        ) : null}
        <form onSubmit={(event) => void submit(event)}>
          <label className="sr-only" htmlFor="work-overview-quick-start">
            Start a new Work thread
          </label>
          <OctantTextarea
            disabled={!createAvailable || submitting}
            id="work-overview-quick-start"
            onChange={(event) => setDraft(event.target.value)}
            placeholder="Describe the next Work thread…"
            rows={3}
            value={draft}
          />
          <OctantButton
            className="project-button"
            disabled={!createAvailable || submitting || draft.trim() === ""}
            type="submit"
            variant="secondary"
          >
            Start thread
          </OctantButton>
        </form>
      </section>

      {createStarterArtifactAvailable ? (
        <section aria-label="Create starter artifact" className="work-overview__composer">
          <form onSubmit={(event) => void submitStarterArtifact(event)}>
            <label>
              <span>Artifact kind</span>
              <OctantNativeSelect
                aria-label="Artifact kind"
                disabled={starterArtifactSubmitting}
                onChange={() => {}}
                value="markdown"
              >
                <option value="markdown">markdown</option>
              </OctantNativeSelect>
            </label>
            <label>
              <span>Artifact path</span>
              <OctantInput
                aria-label="Artifact path"
                disabled={starterArtifactSubmitting}
                onChange={(event) => setStarterArtifactPath(event.target.value)}
                type="text"
                value={starterArtifactPath}
              />
            </label>
            <label>
              <span>Starter artifact content</span>
              <OctantTextarea
                aria-label="Starter artifact content"
                disabled={starterArtifactSubmitting}
                onChange={(event) => setStarterArtifactContent(event.target.value)}
                rows={6}
                value={starterArtifactContent}
              />
            </label>
            <OctantButton
              className="project-button"
              disabled={
                starterArtifactSubmitting ||
                starterArtifactPath.trim() === "" ||
                starterArtifactContent.trim() === ""
              }
              type="submit"
              variant="secondary"
            >
              Create starter artifact
            </OctantButton>
          </form>
        </section>
      ) : null}
    </section>
  );
}

function OverviewSection(props: {
  readonly onOpenItem?: (itemId: string) => void;
  readonly section: WorkOverviewSectionModel;
  readonly title: string;
}) {
  return (
    <section aria-label={props.title} className="work-overview__section">
      <h2>{props.title}</h2>
      <SectionBody
        {...(props.onOpenItem === undefined ? {} : { onOpenItem: props.onOpenItem })}
        section={props.section}
      />
    </section>
  );
}

function SectionBody(props: {
  readonly onOpenItem?: (itemId: string) => void;
  readonly section: WorkOverviewSectionModel;
}): ReactNode {
  const { section } = props;
  if (section.status === "ready") {
    const items = section.items ?? [];
    if (items.length === 0) {
      return <p role="status">{section.message ?? "Nothing to show."}</p>;
    }
    return (
      <ul className="work-overview__items">
        {items.map((item) => (
          <li key={item.id}>
            {props.onOpenItem !== undefined ? (
              <OctantButton
                className="project-button project-button--quiet"
                onClick={() => props.onOpenItem?.(item.id)}
                type="button"
                variant="ghost"
              >
                <span>{item.label}</span>
                {item.detail !== undefined ? <span>{item.detail}</span> : null}
              </OctantButton>
            ) : (
              <>
                <span>{item.label}</span>
                {item.detail !== undefined ? <span>{item.detail}</span> : null}
              </>
            )}
          </li>
        ))}
      </ul>
    );
  }

  const message = section.message ?? defaultMessage(section.status);
  const role =
    section.status === "loading" || section.status === "empty" || section.status === "stale"
      ? "status"
      : "alert";
  return <p role={role}>{message}</p>;
}

function defaultMessage(status: OverviewSectionStatus): string {
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
