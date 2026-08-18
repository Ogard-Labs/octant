import {
  ArtifactMirrorClientFailure,
  createArtifactMirrorClient,
  type ArtifactMirrorClient,
} from "@octant/client-runtime/artifact-mirror-client";
import type {
  ArtifactMirrorDestination,
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
  readonly busy: boolean;
  readonly message: string | undefined;
  readonly changeDestination: (destination: ArtifactMirrorDestination) => Promise<void>;
  readonly changeAutoCommit: (autoCommit: boolean) => Promise<void>;
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
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string>();

  useEffect(() => {
    if (client === undefined) return;
    const controller = new AbortController();
    void client
      .settings(controller.signal)
      .then((next) => {
        if (!controller.signal.aborted) setSettings(next);
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
        if (result.kind === "mirror-settings") setSettings(result.settings);
        else if (result.kind === "mirror-refused") setMessage(result.message);
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
  };
}
