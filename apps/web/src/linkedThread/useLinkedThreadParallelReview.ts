import {
  createLinkedThreadClient,
  LinkedThreadClientFailure,
  type LinkedThreadClient,
} from "@octant/client-runtime/linked-thread-client";
import type { LinkedThreadAggregate, LinkedThreadPreview } from "@octant/contracts";
import type { ChatThread } from "@octant/contracts/chat";
import { REVIEW_IN_PARALLEL_SKILL_NAME } from "@octant/plugin-host";
import { useCallback, useMemo, useState } from "react";
import {
  buildReviewInParallelPreviewCommand,
  sha256Hex,
} from "./buildReviewInParallelPreviewCommand";
import { parseReviewInParallelDraft } from "./parseReviewInParallelDraft";

export interface LinkedThreadParallelReviewControllerOptions {
  readonly client?: LinkedThreadClient;
  readonly serverUrl?: string;
  readonly thread?: ChatThread;
  readonly windowCapability?: string;
  readonly uuid?: () => string;
}

export interface LinkedThreadParallelReviewController {
  readonly aggregate?: LinkedThreadAggregate;
  readonly dialogOpen: boolean;
  readonly errorMessage?: string;
  readonly notice?: string;
  readonly preview?: LinkedThreadPreview;
  readonly skillName: typeof REVIEW_IN_PARALLEL_SKILL_NAME;
  readonly submitting: boolean;
  readonly close: () => void;
  readonly confirm: () => Promise<boolean>;
  readonly startFromDraft: (draft: string) => Promise<boolean>;
}

export function useLinkedThreadParallelReview(
  options: LinkedThreadParallelReviewControllerOptions,
): LinkedThreadParallelReviewController {
  const client = useMemo(
    () =>
      options.client ??
      (options.serverUrl !== undefined && options.windowCapability !== undefined
        ? createLinkedThreadClient({
            baseUrl: options.serverUrl,
            fetch: globalThis.fetch,
            windowCapability: options.windowCapability,
          })
        : undefined),
    [options.client, options.serverUrl, options.windowCapability],
  );
  const uuid = options.uuid ?? globalThis.crypto.randomUUID.bind(globalThis.crypto);
  const [preview, setPreview] = useState<LinkedThreadPreview | undefined>(undefined);
  const [aggregate, setAggregate] = useState<LinkedThreadAggregate | undefined>(undefined);
  const [notice, setNotice] = useState<string | undefined>(undefined);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | undefined>(undefined);

  const reset = useCallback(() => {
    setPreview(undefined);
    setNotice(undefined);
    setDialogOpen(false);
    setSubmitting(false);
    setErrorMessage(undefined);
  }, []);

  const close = useCallback(() => {
    reset();
  }, [reset]);

  const startFromDraft = useCallback(
    async (draft: string): Promise<boolean> => {
      const parsed = parseReviewInParallelDraft(draft);
      const thread = options.thread;
      if (parsed === null || thread === undefined || client === undefined) return false;
      setSubmitting(true);
      setErrorMessage(undefined);
      setAggregate(undefined);
      try {
        const built = await buildReviewInParallelPreviewCommand({
          thread,
          task: parsed.task,
          requestedCount: parsed.requestedCount,
          requestId: uuid(),
          contextSnapshotId: uuid(),
          digest: sha256Hex,
        });
        if (built.kind === "invalid") {
          setErrorMessage(built.reason);
          setDialogOpen(true);
          return true;
        }
        const result = await client.execute(built.command);
        if (result.kind !== "linked-thread-preview-proposed") {
          setErrorMessage("Linked-thread preview could not be created.");
          setDialogOpen(true);
          return true;
        }
        setPreview(result.preview);
        setNotice(
          "Read-only reviewers will be created as independent Chat threads and started after confirmation.",
        );
        setDialogOpen(true);
        return true;
      } catch (error) {
        setErrorMessage(readFailureMessage(error));
        setDialogOpen(true);
        return true;
      } finally {
        setSubmitting(false);
      }
    },
    [client, options.thread, uuid],
  );

  const confirm = useCallback(async (): Promise<boolean> => {
    if (preview === undefined || client === undefined || submitting) return false;
    setSubmitting(true);
    setErrorMessage(undefined);
    try {
      const result = await client.execute({
        kind: "confirm-linked-thread-preview",
        previewId: preview.previewId,
        expectedVersion: preview.version,
        confirmed: true,
      });
      if (result.kind !== "linked-thread-preview-confirmed") {
        setErrorMessage("Linked-thread fan-out could not be confirmed.");
        return false;
      }
      setPreview(result.preview);
      setAggregate(result.aggregate);
      setDialogOpen(false);
      return true;
    } catch (error) {
      setErrorMessage(readFailureMessage(error));
      return false;
    } finally {
      setSubmitting(false);
    }
  }, [client, preview, submitting]);

  return {
    skillName: REVIEW_IN_PARALLEL_SKILL_NAME,
    dialogOpen,
    submitting,
    close,
    confirm,
    startFromDraft,
    ...(preview === undefined ? {} : { preview }),
    ...(aggregate === undefined ? {} : { aggregate }),
    ...(notice === undefined ? {} : { notice }),
    ...(errorMessage === undefined ? {} : { errorMessage }),
  };
}

function readFailureMessage(error: unknown): string {
  if (error instanceof LinkedThreadClientFailure) return error.message;
  return "Linked-thread parallel review is unavailable.";
}
