import { useEffect, useRef, useState } from "react";
import type { ProjectAvailability, ProjectId } from "@octant/contracts/projects";
import type { WorkOverviewClient } from "@octant/client-runtime/work-overview-client";
import { WorkOverviewClientFailure } from "@octant/client-runtime/work-overview-client";
import { buildWorkOverviewModel, type WorkOverviewProjectionInput } from "./buildWorkOverviewModel";
import type { WorkOverviewModel, OverviewSectionStatus } from "./WorkOverview";

export interface UseWorkOverviewControllerOptions {
  readonly availability?: ProjectAvailability;
  readonly client: WorkOverviewClient | undefined;
  readonly enabled: boolean;
  readonly projectId: ProjectId | undefined;
}

export interface WorkOverviewController {
  readonly model: WorkOverviewModel;
  readonly status: "idle" | "loading" | "ready" | "unavailable" | "unauthorized" | "failure";
  readonly retry: () => void;
}

export function useWorkOverviewController(
  options: UseWorkOverviewControllerOptions,
): WorkOverviewController {
  const [model, setModel] = useState<WorkOverviewModel>(() =>
    buildWorkOverviewModel({
      ...(options.availability === undefined ? {} : { availability: options.availability }),
    }),
  );
  const [status, setStatus] = useState<WorkOverviewController["status"]>("idle");
  const [retryToken, setRetryToken] = useState(0);
  const generation = useRef(0);

  useEffect(() => {
    const operation = ++generation.current;
    if (!options.enabled || options.client === undefined || options.projectId === undefined) {
      setStatus("idle");
      setModel(
        buildWorkOverviewModel({
          ...(options.availability === undefined ? {} : { availability: options.availability }),
        }),
      );
      return;
    }

    setStatus("loading");
    setModel(
      buildWorkOverviewModel({
        ...(options.availability === undefined ? {} : { availability: options.availability }),
        sectionStatus: allSections("loading"),
        sectionMessage: {
          filesAndArtifacts: "Loading recent files and artifacts.",
          workflowsAndThreads: "Loading active workflows and threads.",
          approvals: "Loading approvals.",
          versions: "Loading versions.",
          validation: "Loading validation.",
          exports: "Loading exports and handoffs.",
        },
      }),
    );

    void options.client
      .load(options.projectId)
      .then((projection) => {
        if (operation !== generation.current) return;
        const input: WorkOverviewProjectionInput = {
          ...(options.availability === undefined ? {} : { availability: options.availability }),
          filesAndArtifacts: projection.filesAndArtifacts,
          workflowsAndThreads: projection.workflowsAndThreads,
          approvals: projection.approvals,
          versions: projection.versions,
          validation: projection.validation,
          exports: projection.exports,
        };
        setModel(buildWorkOverviewModel(input));
        setStatus("ready");
      })
      .catch((error: unknown) => {
        if (operation !== generation.current) return;
        const failureStatus = mapFailure(error);
        setStatus(failureStatus);
        setModel(
          buildWorkOverviewModel({
            ...(options.availability === undefined ? {} : { availability: options.availability }),
            sectionStatus: allSections(failureStatus === "idle" ? "failure" : failureStatus),
            sectionMessage: {
              filesAndArtifacts: messageFor(failureStatus, "Recent files"),
              workflowsAndThreads: messageFor(failureStatus, "Workflows and threads"),
              approvals: messageFor(failureStatus, "Approvals"),
              versions: messageFor(failureStatus, "Versions"),
              validation: messageFor(failureStatus, "Validation"),
              exports: messageFor(failureStatus, "Export history"),
            },
          }),
        );
      });
  }, [options.availability, options.client, options.enabled, options.projectId, retryToken]);

  return {
    model,
    status,
    retry: () => setRetryToken((value) => value + 1),
  };
}

function allSections(
  status: OverviewSectionStatus,
): Partial<Record<keyof WorkOverviewModel, OverviewSectionStatus>> {
  return {
    filesAndArtifacts: status,
    workflowsAndThreads: status,
    approvals: status,
    versions: status,
    validation: status,
    exports: status,
  };
}

function mapFailure(
  error: unknown,
): Exclude<WorkOverviewController["status"], "loading" | "ready"> {
  if (error instanceof WorkOverviewClientFailure) {
    if (error.status === 401) return "unauthorized";
    if (error.status === 404) return "unavailable";
  }
  return "failure";
}

function messageFor(
  status: Exclude<WorkOverviewController["status"], "loading" | "ready">,
  label: string,
): string {
  switch (status) {
    case "unauthorized":
      return `${label} are unauthorized.`;
    case "unavailable":
      return `${label} are unavailable.`;
    case "idle":
    case "failure":
      return `${label} could not be loaded.`;
  }
}
