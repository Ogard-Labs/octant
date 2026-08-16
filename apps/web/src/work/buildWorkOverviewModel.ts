import type { ProjectAvailability } from "@octant/contracts/projects";
import type { WorkOverviewItem as ContractOverviewItem } from "@octant/contracts/work-overview";
import type {
  WorkOverviewItem,
  WorkOverviewModel,
  WorkOverviewSectionModel,
  OverviewSectionStatus,
} from "./WorkOverview";

/**
 * Projection-facing inputs for the Work Project Overview. Callers compose
 * existing normalized artifact, thread, approval, version, validation, and
 * export projections — never invent metrics or Code surfaces.
 */
export interface WorkOverviewProjectionInput {
  readonly availability?: ProjectAvailability;
  readonly filesAndArtifacts?: ReadonlyArray<WorkOverviewItem | ContractOverviewItem>;
  readonly workflowsAndThreads?: ReadonlyArray<WorkOverviewItem | ContractOverviewItem>;
  readonly approvals?: ReadonlyArray<WorkOverviewItem | ContractOverviewItem>;
  readonly versions?: ReadonlyArray<WorkOverviewItem | ContractOverviewItem>;
  readonly validation?: ReadonlyArray<WorkOverviewItem | ContractOverviewItem>;
  readonly exports?: ReadonlyArray<WorkOverviewItem | ContractOverviewItem>;
  readonly sectionStatus?: Partial<Record<keyof WorkOverviewModel, OverviewSectionStatus>>;
  readonly sectionMessage?: Partial<Record<keyof WorkOverviewModel, string>>;
}

const EMPTY_MESSAGES: Record<keyof WorkOverviewModel, string> = {
  filesAndArtifacts: "No recent files or artifacts in this Project yet.",
  workflowsAndThreads: "No active workflows or related threads yet.",
  approvals: "No pending approvals.",
  versions: "No versions recorded yet.",
  validation: "No validation status for this Project yet.",
  exports: "No exports or handoffs recorded.",
};

/**
 * Builds a Work Overview model from existing projections. Unavailable Project
 * roots force confined sections into an unavailable state; callers may override
 * individual section status for loading, stale, unauthorized, or failure.
 */
export function buildWorkOverviewModel(input: WorkOverviewProjectionInput = {}): WorkOverviewModel {
  const rootUnavailable = input.availability?.status === "unavailable";
  return {
    filesAndArtifacts: section(
      "filesAndArtifacts",
      input.filesAndArtifacts,
      input,
      rootUnavailable,
    ),
    workflowsAndThreads: section(
      "workflowsAndThreads",
      input.workflowsAndThreads,
      input,
      rootUnavailable,
    ),
    approvals: section("approvals", input.approvals, input, rootUnavailable),
    versions: section("versions", input.versions, input, rootUnavailable),
    validation: section("validation", input.validation, input, rootUnavailable),
    exports: section("exports", input.exports, input, rootUnavailable),
  };
}

function section(
  key: keyof WorkOverviewModel,
  items: ReadonlyArray<WorkOverviewItem | ContractOverviewItem> | undefined,
  input: WorkOverviewProjectionInput,
  rootUnavailable: boolean,
): WorkOverviewSectionModel {
  const override = input.sectionStatus?.[key];
  if (override !== undefined && override !== "ready" && override !== "empty") {
    return {
      status: override,
      message:
        input.sectionMessage?.[key] ??
        messageFor(key, override, unavailableReason(input.availability)),
      items: normalizeItems(items ?? []),
    };
  }
  if (rootUnavailable) {
    return {
      status: "unavailable",
      message:
        input.sectionMessage?.[key] ??
        unavailableReason(input.availability) ??
        "This Work Project root is unavailable.",
      items: [],
    };
  }
  const list = normalizeItems(items ?? []);
  if (list.length === 0) {
    return {
      status: "empty",
      message: input.sectionMessage?.[key] ?? EMPTY_MESSAGES[key],
      items: [],
    };
  }
  return { status: "ready", items: list };
}

function normalizeItems(
  items: ReadonlyArray<WorkOverviewItem | ContractOverviewItem>,
): WorkOverviewItem[] {
  return items.map((item) =>
    item.detail === undefined
      ? { id: item.id, label: item.label }
      : { id: item.id, label: item.label, detail: item.detail },
  );
}

function unavailableReason(availability: ProjectAvailability | undefined): string | undefined {
  return availability?.status === "unavailable" ? availability.reason : undefined;
}

function messageFor(
  key: keyof WorkOverviewModel,
  status: OverviewSectionStatus,
  reason: string | undefined,
): string {
  if (reason !== undefined && (status === "unavailable" || status === "unauthorized")) {
    return reason;
  }
  switch (status) {
    case "loading":
      return `Loading ${label(key)}.`;
    case "unavailable":
      return `${title(key)} are unavailable.`;
    case "unauthorized":
      return `${title(key)} are unauthorized.`;
    case "stale":
      return `${title(key)} may be out of date.`;
    case "failure":
      return `${title(key)} could not be loaded.`;
    case "empty":
      return EMPTY_MESSAGES[key];
    case "ready":
      return "";
  }
}

function label(key: keyof WorkOverviewModel): string {
  switch (key) {
    case "filesAndArtifacts":
      return "recent files and artifacts";
    case "workflowsAndThreads":
      return "active workflows and threads";
    case "approvals":
      return "approvals";
    case "versions":
      return "versions";
    case "validation":
      return "validation";
    case "exports":
      return "exports and handoffs";
  }
}

function title(key: keyof WorkOverviewModel): string {
  switch (key) {
    case "filesAndArtifacts":
      return "Recent files";
    case "workflowsAndThreads":
      return "Workflows and threads";
    case "approvals":
      return "Approvals";
    case "versions":
      return "Versions";
    case "validation":
      return "Validation";
    case "exports":
      return "Export history";
  }
}
