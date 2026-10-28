import {
  ArtifactLibraryClientFailure,
  changeArtifactTag,
} from "@octant/client-runtime/artifact-library-client";
import type { CanvasTagCommand } from "@octant/contracts/canvas-tags";
import { useCallback, useState } from "react";

export interface ArtifactTagsOptions {
  readonly serverUrl?: string;
  readonly windowCapability?: string;
  /** Injected in tests and on hosts that build the client elsewhere. */
  readonly load?: typeof changeArtifactTag;
  /** Called after a change the host accepted, so the listing shows it. */
  readonly onChanged: () => void;
}

export interface ArtifactTags {
  readonly busy: boolean;
  readonly message: string | undefined;
  /** Sends one tag change; resolves to whether the host accepted it. */
  readonly change: (command: CanvasTagCommand) => Promise<boolean>;
}

/**
 * The person's own tags on the artifacts, as one library surface changes
 * them. A refusal is the host's answer, not a failure to reach it, so it is
 * shown beside the page rather than thrown: "Canvas already carries this tag"
 * is a fact the person acts on, not an error to retry.
 */
export function useArtifactTags(options: ArtifactTagsOptions): ArtifactTags {
  const { serverUrl, windowCapability, load, onChanged } = options;
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string>();

  const change = useCallback(
    async (command: CanvasTagCommand): Promise<boolean> => {
      if (serverUrl === undefined || windowCapability === undefined) {
        setMessage("Artifact tags are unavailable.");
        return false;
      }
      setBusy(true);
      try {
        const result = await (load ?? changeArtifactTag)(
          {
            baseUrl: serverUrl,
            fetch: globalThis.fetch,
            windowCapability,
          },
          command,
        );
        if (result.kind === "accepted") {
          setMessage(undefined);
          onChanged();
          return true;
        }
        setMessage(result.message);
        return false;
      } catch (error) {
        setMessage(
          error instanceof ArtifactLibraryClientFailure
            ? error.message
            : "Artifact tags are unavailable.",
        );
        return false;
      } finally {
        setBusy(false);
      }
    },
    [load, onChanged, serverUrl, windowCapability],
  );

  return { busy, message, change };
}
