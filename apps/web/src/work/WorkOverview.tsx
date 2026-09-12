import { ComposerAttachButton } from "../composer/ComposerAttachButton";
import type { ProviderInstanceId, ProviderModelId } from "@octant/contracts";
import type { WorkProjectStatus, WorkStatusDatedItem } from "@octant/contracts/work-project-status";
import type { CreateHostViewScope, PickerGroup, ModelPickerSelection } from "@octant/domain";
import { CalendarClock, FolderOpen, ShieldCheck } from "lucide-react";
import { useState, type ClipboardEvent, type FormEvent, type ReactNode } from "react";
import { clipboardHasImage } from "../chat/composerImagePaste";
import { selectedModelReadsImages, useWorkComposerImages } from "./composer/useWorkComposerImages";
import { WorkImageAttachmentChips } from "./composer/WorkImageAttachmentChips";
import { HostSelector } from "../shell/HostSelector";
import type { HostId, HostIdentity } from "@octant/contracts/host";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantInput } from "../ui/base/OctantInput";
import { OctantSelectField } from "../ui/base/OctantSelect";
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
  /** What STATUS.md says, when the host could read it. */
  readonly status?: WorkProjectStatus;
  readonly folder: WorkOverviewSectionModel;
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
  readonly onCreateThread: (
    draft: string,
    images?: ReadonlyArray<File>,
  ) => boolean | Promise<boolean>;
  readonly onOpenThread?: (threadId: string) => void;
  readonly onOpenSettings?: () => void;
  readonly projectName?: string;
  readonly providerGroups?: ReadonlyArray<PickerGroup>;
  readonly selectedModelId?: ProviderModelId;
  readonly selectedProviderInstanceId?: ProviderInstanceId;
}

const SECTIONS = [
  { key: "workflowsAndThreads", title: "Recent tasks" },
  { key: "folder", title: "In the folder" },
  { key: "filesAndArtifacts", title: "Produced by Octant" },
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
  const images = useWorkComposerImages();
  const imageSupport = selectedModelReadsImages(providerGroups, {
    ...(props.selectedProviderInstanceId === undefined
      ? {}
      : { providerInstanceId: props.selectedProviderInstanceId }),
    ...(props.selectedModelId === undefined ? {} : { modelId: props.selectedModelId }),
  });
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
      const staged = images.filesForSend();
      const created =
        staged.length === 0
          ? await props.onCreateThread(normalized)
          : await props.onCreateThread(normalized, staged);
      if (created) {
        images.clearAfterAccepted();
        setDraft("");
      }
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
      {props.model.status === undefined ? null : <WorkStatusCard status={props.model.status} />}
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
        <form noValidate onSubmit={(event) => void submit(event)}>
          <label className="sr-only" htmlFor="work-overview-quick-start">
            Start a new task
          </label>
          <WorkImageAttachmentChips images={images} />
          <OctantTextarea
            disabled={!createAvailable || submitting}
            id="work-overview-quick-start"
            onChange={(event) => setDraft(event.target.value)}
            onPaste={(event: ClipboardEvent<HTMLTextAreaElement>) => {
              if (!clipboardHasImage(event.clipboardData)) return;
              event.preventDefault();
              if (imageSupport === false) {
                images.refuse(
                  "The selected model does not accept images. Choose an image-capable model.",
                );
                return;
              }
              images.consumePaste(event.clipboardData);
            }}
            placeholder="Describe the next task…"
            rows={3}
            value={draft}
          />
          <ComposerAttachButton
            accept="image/png,image/jpeg,image/webp,image/gif"
            busy={!createAvailable || submitting}
            refusedReason={
              imageSupport === false
                ? "The selected model does not accept images. Choose an image-capable model."
                : undefined
            }
            onRefused={images.refuse}
            onFileSelected={(file) => images.attach([file])}
          />
          <OctantButton
            className="project-button"
            disabled={!createAvailable || submitting || draft.trim() === ""}
            type="submit"
            variant="secondary"
          >
            Start task
          </OctantButton>
        </form>
      </section>

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

      {createStarterArtifactAvailable ? (
        <section aria-label="Create starter artifact" className="work-overview__composer">
          <form noValidate onSubmit={(event) => void submitStarterArtifact(event)}>
            <label>
              <span>Artifact kind</span>
              <OctantSelectField
                aria-label="Artifact kind"
                disabled={starterArtifactSubmitting}
                onValueChange={() => {}}
                options={[{ id: "markdown", label: "markdown" }]}
                value="markdown"
              />
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

/**
 * Where the work stands, from the folder's own STATUS.md: the current status
 * the agent or the person wrote, and every dated line that has passed or is
 * close. A Project without the file says so rather than showing nothing.
 */
function WorkStatusCard({ status }: { readonly status: WorkProjectStatus }) {
  const due = [...status.deadlines, ...status.followUps]
    .filter((item) => item.state !== "upcoming")
    .sort((left, right) => left.date.localeCompare(right.date));
  const upcoming = [...status.deadlines, ...status.followUps]
    .filter((item) => item.state === "upcoming")
    .sort((left, right) => left.date.localeCompare(right.date))
    .slice(0, 5);
  return (
    <section aria-label="Status" className="work-overview__section work-status">
      <div className="work-status__head">
        <h2>Status</h2>
        <span className="work-status__updated">
          {!status.hasStatusFile
            ? "No STATUS.md yet — the first task creates it"
            : status.lastUpdatedOn === undefined
              ? "Undated"
              : `Last updated ${status.lastUpdatedOn}${status.stale ? " · stale" : ""}`}
        </span>
      </div>
      {status.currentStatus === undefined ? null : (
        <p className="work-status__current">{status.currentStatus}</p>
      )}
      {due.length === 0 ? null : (
        <div className="work-status__due" role="status">
          <h3>
            <CalendarClock aria-hidden="true" size={14} strokeWidth={1.8} />
            Follow-ups due
          </h3>
          <ul className="work-overview__items">
            {due.map((item) => (
              <DatedItem item={item} key={`${item.date}:${item.text}`} />
            ))}
          </ul>
        </div>
      )}
      {upcoming.length === 0 ? null : (
        <div className="work-status__upcoming">
          <h3>Coming up</h3>
          <ul className="work-overview__items">
            {upcoming.map((item) => (
              <DatedItem item={item} key={`${item.date}:${item.text}`} />
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

function DatedItem({ item }: { readonly item: WorkStatusDatedItem }) {
  return (
    <li className={`work-status__item work-status__item--${item.state}`}>
      <span>{item.text}</span>
      <span>
        {item.date}
        {item.state === "overdue" ? " · overdue" : item.state === "due-soon" ? " · due soon" : ""}
      </span>
    </li>
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
