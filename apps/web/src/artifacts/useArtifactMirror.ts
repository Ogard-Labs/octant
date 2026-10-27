import {
  ArtifactMirrorClientFailure,
  createArtifactMirrorClient,
  type ArtifactMirrorClient,
} from "@octant/client-runtime/artifact-mirror-client";
import type {
  ArtifactMirrorDestination,
  ArtifactMirrorProjectStatus,
  ArtifactMirrorSettings,
} from "@octant/contracts/artifact-mirror";
import { useCallback, useEffect, useMemo, useState } from "react";

export interface ArtifactMirrorOptions {
  readonly serverUrl?: string;
  readonly windowCapability?: string;
  /** Injected in tests and on hosts that build the client elsewhere. */
  readonly client?: ArtifactMirrorClient;
}

export interface ArtifactMirror {
  readonly settings: ArtifactMirrorSettings | undefined;
  /** Each Project's latest outcome for the destination it uses now, as the host reports it. */
  readonly projects: ReadonlyArray<ArtifactMirrorProjectStatus>;
  readonly busy: boolean;
  readonly message: string | undefined;
  readonly changeDestination: (destination: ArtifactMirrorDestination) => Promise<void>;
  readonly changeAutoCommit: (autoCommit: boolean) => Promise<void>;
  /**
   * Name the folder for a Project whose mirror the host refused: its own
   * destination when it has one, the host-wide one otherwise.
   */
  readonly chooseFolderAgain: (
    status: ArtifactMirrorProjectStatus,
    folder: string,
  ) => Promise<void>;
}

/**
 * Where this host mirrors artifacts.
 *
 * The host owns the setting and its version; every change carries the version
 * the caller read, so two windows cannot quietly overwrite each other's choice.
 * A refusal is shown in the host's own words rather than re-derived here.
 */
export function useArtifactMirror(options: ArtifactMirrorOptions): ArtifactMirror {
  const { serverUrl, windowCapability } = options;
  const injected = options.client;
  const client = useMemo(() => {
    if (injected !== undefined) return injected;
    if (serverUrl === undefined || windowCapability === undefined) return undefined;
    try {
      return createArtifactMirrorClient({ baseUrl: serverUrl, fetch, windowCapability });
    } catch {
      return undefined;
    }
  }, [injected, serverUrl, windowCapability]);

  const [settings, setSettings] = useState<ArtifactMirrorSettings>();
  const [projects, setProjects] = useState<ReadonlyArray<ArtifactMirrorProjectStatus>>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string>();

  useEffect(() => {
    if (client === undefined) return;
    const controller = new AbortController();
    void client
      .read(controller.signal)
      .then((next) => {
        if (controller.signal.aborted) return;
        setSettings(next.settings);
        setProjects(next.projects);
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setMessage(
          error instanceof ArtifactMirrorClientFailure
            ? error.message
            : "Artifact mirroring is unavailable.",
        );
      });
    return () => controller.abort();
  }, [client]);

  const run = useCallback(
    async (build: (version: number) => Parameters<ArtifactMirrorClient["execute"]>[0]) => {
      if (client === undefined || settings === undefined) return;
      setBusy(true);
      setMessage(undefined);
      try {
        const result = await client.execute(build(Number(settings.version)));
        if (result.kind === "mirror-settings") {
          setSettings(result.settings);
          // The host decides which Project outcomes still apply to the new
          // destinations, so they are read again rather than guessed here.
          // The change already landed, so a failed read keeps the outcomes
          // shown rather than reporting the change as failed.
          const next = await client.read().catch(() => undefined);
          if (next !== undefined) {
            setSettings(next.settings);
            setProjects(next.projects);
          }
        } else if (result.kind === "mirror-refused") setMessage(result.message);
      } catch (error) {
        setMessage(
          error instanceof ArtifactMirrorClientFailure
            ? error.message
            : "The artifact mirror command failed.",
        );
      } finally {
        setBusy(false);
      }
    },
    [client, settings],
  );

  return {
    settings,
    projects,
    busy,
    message,
    changeDestination: useCallback(
      (destination) =>
        run((expectedVersion) => ({
          kind: "set-artifact-mirror-fallback",
          expectedVersion: expectedVersion as never,
          destination,
        })),
      [run],
    ),
    changeAutoCommit: useCallback(
      (autoCommit) =>
        run((expectedVersion) => ({
          kind: "set-artifact-mirror-auto-commit",
          expectedVersion: expectedVersion as never,
          autoCommit,
        })),
      [run],
    ),
    chooseFolderAgain: useCallback(
      (status, folder) =>
        run((expectedVersion) => {
          const destination = { kind: "global-folder", canonicalRoot: folder as never } as const;
          return status.source === "project"
            ? {
                kind: "set-artifact-mirror-override",
                expectedVersion: expectedVersion as never,
                projectId: status.projectId,
                destination,
              }
            : {
                kind: "set-artifact-mirror-fallback",
                expectedVersion: expectedVersion as never,
                destination,
              };
        }),
      [run],
    ),
  };
}
