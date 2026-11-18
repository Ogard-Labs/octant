import type { ProjectClient } from "@octant/client-runtime/project-client";
import type { ProjectId } from "@octant/contracts";
import { useEffect, useState } from "react";

/**
 * What the band says of a Project's own checkout, for a window with no thread
 * open (the Code start screen and draft, where the next thread would run).
 * `none` means the Project has no Git checkout to measure.
 */
export type ProjectCheckoutChanges =
  | { readonly status: "none" }
  | { readonly status: "reading"; readonly insertions?: undefined; readonly deletions?: undefined }
  | {
      readonly status: "known";
      readonly insertions: number | undefined;
      readonly deletions: number | undefined;
      /** A newer reading is on its way; the counts may describe an earlier tree. */
      readonly updating: boolean;
    };

interface Reading {
  readonly projectId: string;
  readonly changes: ProjectCheckoutChanges;
}

/**
 * Reads the Project's checkout through the Project service's environment read,
 * which the Environment panel already uses, and keeps the last counts on screen
 * while a later read lands. A read that fails says nothing new.
 */
export function useProjectCheckoutChanges(input: {
  readonly client: ProjectClient | undefined;
  readonly projectId: ProjectId | undefined;
  readonly enabled: boolean;
  /** Moves when the host says the checkout or its board changed. */
  readonly revision: number;
}): ProjectCheckoutChanges {
  const { client, projectId, enabled, revision } = input;
  const [reading, setReading] = useState<Reading>();
  useEffect(() => {
    if (!enabled || client === undefined || projectId === undefined) return;
    const key = String(projectId);
    const controller = new AbortController();
    setReading((current) =>
      current?.projectId === key && current.changes.status === "known"
        ? { projectId: key, changes: { ...current.changes, updating: true } }
        : { projectId: key, changes: { status: "reading" } },
    );
    client.environment(projectId, controller.signal, true).then(
      (observation) => {
        if (controller.signal.aborted) return;
        setReading({
          projectId: key,
          changes:
            observation.status === "ready"
              ? {
                  status: "known",
                  insertions: observation.insertions,
                  deletions: observation.deletions,
                  updating: false,
                }
              : { status: "none" },
        });
      },
      () => {
        if (controller.signal.aborted) return;
        setReading((current) =>
          current?.projectId === key && current.changes.status === "known"
            ? { projectId: key, changes: { ...current.changes, updating: true } }
            : current,
        );
      },
    );
    return () => controller.abort();
  }, [client, enabled, projectId, revision]);
  // A reading of another Project must not describe this one.
  return reading !== undefined && String(projectId) === reading.projectId
    ? reading.changes
    : { status: "reading" };
}
