import {
  ArtifactLibraryClientFailure,
  executeSyncedArtifactCommand,
} from "@octant/client-runtime/artifact-library-client";
import type {
  ArtifactLibraryEntry,
  ArtifactSyncedCommand,
  ArtifactSyncedDetail,
  ArtifactSyncedResult,
} from "@octant/contracts/artifact-library";
import type { CanvasId } from "@octant/contracts";
import { useCallback, useRef, useState } from "react";

export interface SyncedArtifactsOptions {
  readonly serverUrl?: string;
  readonly windowCapability?: string;
  readonly execute?: typeof executeSyncedArtifactCommand;
  /** The library changed: a version was kept, merged, restored, or opened. */
  readonly onChanged: () => void;
  /** An artifact is now open in a thread here; show it. */
  readonly onOpened: (entry: ArtifactLibraryEntry) => void;
}

export interface SyncedArtifacts {
  readonly available: boolean;
  readonly selected: CanvasId | undefined;
  readonly detail: ArtifactSyncedDetail | undefined;
  readonly busy: boolean;
  /** The host's answer inside the dialog. */
  readonly message: string | undefined;
  /** The host's answer to a card's Restore, shown over the library. */
  readonly notice: string | undefined;
  readonly select: (canvasId: CanvasId) => Promise<void>;
  readonly run: (command: ArtifactSyncedCommand) => Promise<void>;
  /** Runs a command on the artifact the dialog shows. */
  readonly runOnSelected: (command: (canvasId: CanvasId) => ArtifactSyncedCommand) => Promise<void>;
  readonly close: () => void;
}

/** What a published version means to the person, in one sentence. */
function publishedMessage(
  result: Extract<ArtifactSyncedResult, { kind: "artifact-synced-published" }>,
) {
  return result.published
    ? "Done. Your other computers get this version on their next sync."
    : "Done here. It goes to your other computers once the store can be reached.";
}

/**
 * The library's synced-artifact commands, as the dialog and the cards use
 * them. The host decides every one; this keeps the newest answer and asks
 * the library to read itself again after anything changed.
 */
export function useSyncedArtifacts(options: SyncedArtifactsOptions): SyncedArtifacts {
  const { serverUrl, windowCapability } = options;
  const execute = options.execute ?? executeSyncedArtifactCommand;
  const [selected, setSelected] = useState<CanvasId>();
  const [detail, setDetail] = useState<ArtifactSyncedDetail>();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const latest = useRef(0);
  const { onChanged, onOpened } = options;
  const available = serverUrl !== undefined && windowCapability !== undefined;

  const send = useCallback(
    async (command: ArtifactSyncedCommand): Promise<ArtifactSyncedResult | string> => {
      if (serverUrl === undefined || windowCapability === undefined) {
        return "Synced artifacts are unavailable.";
      }
      try {
        return await execute({ baseUrl: serverUrl, fetch, windowCapability }, command);
      } catch (error) {
        return error instanceof ArtifactLibraryClientFailure
          ? error.message
          : "Synced artifacts are unavailable.";
      }
    },
    [execute, serverUrl, windowCapability],
  );

  const select = useCallback(
    async (canvasId: CanvasId) => {
      const request = (latest.current += 1);
      setSelected(canvasId);
      setDetail(undefined);
      setMessage(undefined);
      const result = await send({ kind: "detail", canvasId });
      if (request !== latest.current) return;
      if (typeof result === "string") setMessage(result);
      else if (result.kind === "artifact-synced-detail") setDetail(result);
      else if (result.kind === "artifact-synced-refused") setMessage(result.message);
    },
    [send],
  );

  const run = useCallback(
    async (command: ArtifactSyncedCommand) => {
      const request = (latest.current += 1);
      const inDialog = selected !== undefined && String(selected) === String(command.canvasId);
      setBusy(true);
      if (inDialog) setMessage(undefined);
      else setNotice(undefined);
      const result = await send(command);
      if (request !== latest.current) {
        setBusy(false);
        return;
      }
      setBusy(false);
      const say = inDialog ? setMessage : setNotice;
      if (typeof result === "string") {
        say(result);
        return;
      }
      switch (result.kind) {
        case "artifact-synced-refused":
          say(result.message);
          return;
        case "artifact-synced-detail":
          setDetail(result);
          return;
        case "artifact-synced-opened":
          setSelected(undefined);
          setDetail(undefined);
          setNotice(
            result.omittedBlocks === undefined
              ? undefined
              : `Merged. ${String(result.omittedBlocks)} block${result.omittedBlocks === 1 ? "" : "s"} could not be carried over.`,
          );
          onChanged();
          onOpened(result.entry);
          return;
        case "artifact-synced-published": {
          say(publishedMessage(result));
          onChanged();
          if (inDialog) {
            const refreshed = await send({ kind: "detail", canvasId: command.canvasId });
            if (request === latest.current && typeof refreshed !== "string") {
              if (refreshed.kind === "artifact-synced-detail") setDetail(refreshed);
            }
          }
          return;
        }
        default: {
          const unexpected: never = result;
          say(`Unexpected answer: ${JSON.stringify(unexpected)}`);
        }
      }
    },
    [onChanged, onOpened, selected, send],
  );

  const runOnSelected = useCallback(
    async (command: (canvasId: CanvasId) => ArtifactSyncedCommand) => {
      if (selected === undefined) return;
      await run(command(selected));
    },
    [run, selected],
  );

  const close = useCallback(() => {
    latest.current += 1;
    setSelected(undefined);
    setDetail(undefined);
    setMessage(undefined);
    setBusy(false);
  }, []);

  return {
    available,
    selected,
    detail,
    busy,
    message,
    notice,
    select,
    run,
    runOnSelected,
    close,
  };
}
