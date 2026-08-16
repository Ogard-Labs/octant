import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import type { PreviewClient } from "@octant/client-runtime/preview-client";
import { PreviewClientFailure } from "@octant/client-runtime/preview-client";
import type {
  PreviewChunk,
  PreviewHandoffKind,
  PreviewKind,
  PreviewManifest,
  PreviewOutcome,
  PreviewSourceVersion,
  PreviewTarget,
} from "@octant/contracts/previews";

export type PreviewTransportStatus =
  | "idle"
  | "opening"
  | "streaming"
  | "ready"
  | "reconnecting"
  | "unauthorized"
  | "unavailable"
  | "unsupported"
  | "stale"
  | "too-large"
  | "limited-fidelity"
  | "interrupted"
  | "failure";

export interface PreviewControllerModel {
  readonly status: PreviewTransportStatus;
  readonly message?: string;
  readonly target?: PreviewTarget;
  readonly manifest?: PreviewManifest;
  readonly manifestKind?: PreviewKind;
  readonly sourceVersion?: PreviewSourceVersion;
  readonly chunks: ReadonlyArray<PreviewChunk>;
  readonly canRetry: boolean;
  readonly canRevealInFinder: boolean;
  readonly canQuickLook: boolean;
  readonly canOpenExternally: boolean;
}

export interface UsePreviewControllerOptions {
  readonly client: PreviewClient | undefined;
  readonly target: PreviewTarget | undefined;
  readonly enabled: boolean;
}

export interface PreviewController {
  readonly model: PreviewControllerModel;
  readonly retry: () => void;
  readonly cancel: () => void;
  readonly handoff: (kind: PreviewHandoffKind) => Promise<void>;
  readonly cancelHandoff: () => void;
  readonly handoffPending: boolean;
  readonly handoffMessage?: string;
}

const INITIAL_MODEL: PreviewControllerModel = {
  status: "idle",
  chunks: [],
  canRetry: false,
  canRevealInFinder: false,
  canQuickLook: false,
  canOpenExternally: false,
};

const HANDOFF_FAILURE_MESSAGE = "Octant could not complete the preview handoff.";

export function usePreviewController(options: UsePreviewControllerOptions): PreviewController {
  const [model, setModel] = useState<PreviewControllerModel>(INITIAL_MODEL);
  const [retryToken, setRetryToken] = useState(0);
  const [handoffPending, setHandoffPending] = useState(false);
  const [handoffMessage, setHandoffMessage] = useState<string | undefined>();
  const generation = useRef(0);
  const cancelRef = useRef<AbortController | undefined>(undefined);
  const handoffGeneration = useRef(0);
  const handoffAbortRef = useRef<AbortController | undefined>(undefined);
  const modelRef = useRef(model);
  modelRef.current = model;

  const retry = useCallback(() => setRetryToken((v) => v + 1), []);

  const cancel = useCallback(() => {
    const controller = cancelRef.current;
    if (controller === undefined) return;
    cancelRef.current = undefined;
    controller.abort();
    if (options.client !== undefined && options.target !== undefined) {
      void options.client.cancel(options.target).catch(() => {
        /* cancellation is best-effort; surface interrupted state regardless */
      });
    }
  }, [options.client, options.target]);

  const cancelHandoff = useCallback(() => {
    handoffGeneration.current += 1;
    const controller = handoffAbortRef.current;
    handoffAbortRef.current = undefined;
    controller?.abort();
    setHandoffPending(false);
    setHandoffMessage("Handoff cancelled.");
  }, []);

  const handoff = useCallback(
    async (kind: PreviewHandoffKind) => {
      if (options.client === undefined || options.target === undefined) return;
      if (modelRef.current.status === "stale") return;

      const previous = handoffAbortRef.current;
      if (previous !== undefined) previous.abort();
      const controller = new AbortController();
      handoffAbortRef.current = controller;
      const operation = ++handoffGeneration.current;
      setHandoffPending(true);
      setHandoffMessage(undefined);

      try {
        const reply = await options.client.handoff(options.target, kind, controller.signal);
        if (handoffGeneration.current !== operation) return;
        switch (reply.kind) {
          case "done":
            setHandoffMessage(handoffDoneMessage(kind));
            break;
          case "unauthorized":
          case "unavailable":
            // Fail closed without disclosing paths or target metadata.
            setHandoffMessage(HANDOFF_FAILURE_MESSAGE);
            break;
          case "failed":
            setHandoffMessage(
              reply.reason === "cancelled"
                ? "Handoff cancelled."
                : (reply.message ?? HANDOFF_FAILURE_MESSAGE),
            );
            break;
        }
      } catch (error) {
        if (handoffGeneration.current !== operation) return;
        if (controller.signal.aborted) {
          setHandoffMessage("Handoff cancelled.");
          return;
        }
        if (error instanceof PreviewClientFailure && error.status === 401) {
          setHandoffMessage(HANDOFF_FAILURE_MESSAGE);
          return;
        }
        setHandoffMessage(HANDOFF_FAILURE_MESSAGE);
      } finally {
        if (handoffAbortRef.current === controller) handoffAbortRef.current = undefined;
        if (handoffGeneration.current === operation) setHandoffPending(false);
      }
    },
    [options.client, options.target],
  );

  useEffect(() => {
    const operation = ++generation.current;
    // A target or enablement change supersedes any in-flight handoff.
    handoffGeneration.current += 1;
    handoffAbortRef.current?.abort();
    handoffAbortRef.current = undefined;
    setHandoffPending(false);
    setHandoffMessage(undefined);

    if (!options.enabled || options.client === undefined || options.target === undefined) {
      cancelRef.current = undefined;
      setModel(INITIAL_MODEL);
      return;
    }

    const client = options.client;
    const target = options.target;
    const controller = new AbortController();
    cancelRef.current = controller;
    setModel({
      status: "opening",
      message: "Opening preview…",
      target,
      chunks: [],
      canRetry: false,
      canRevealInFinder: false,
      canQuickLook: false,
      canOpenExternally: false,
    });

    void runPreview(client, target, controller, operation, generation, setModel).finally(() => {
      if (cancelRef.current === controller) cancelRef.current = undefined;
    });

    return () => {
      handoffGeneration.current += 1;
      handoffAbortRef.current?.abort();
      handoffAbortRef.current = undefined;
      if (cancelRef.current !== controller) return;
      cancelRef.current = undefined;
      controller.abort();
      void client.cancel(target).catch(() => {
        /* cancellation is best-effort; the next target owns the active state */
      });
    };
  }, [options.client, options.enabled, options.target, retryToken]);

  return {
    model,
    retry,
    cancel,
    handoff,
    cancelHandoff,
    handoffPending,
    ...(handoffMessage === undefined ? {} : { handoffMessage }),
  };
}

function handoffDoneMessage(kind: PreviewHandoffKind): string {
  switch (kind) {
    case "reveal-in-finder":
      return "Revealed in Finder.";
    case "quick-look":
      return "Opened Quick Look.";
    case "open-external":
      return "Opened in the native application.";
  }
}

async function runPreview(
  client: PreviewClient,
  target: PreviewTarget,
  controller: AbortController,
  operation: number,
  generation: RefObject<number>,
  setModel: (model: PreviewControllerModel) => void,
): Promise<void> {
  let outcome: PreviewOutcome;
  try {
    outcome = await client.open(target);
  } catch (error) {
    if (operation !== generation.current) return;
    setModel(failureModel(error, target));
    return;
  }
  if (operation !== generation.current) return;

  let openState = modelFromOutcome(outcome, target);
  setModel(openState);
  if (openState.status !== "ready" && openState.status !== "limited-fidelity") return;

  const sourceVersion = openState.sourceVersion;
  if (sourceVersion === undefined) return;

  // Stream chunks until a final chunk arrives or the operation is superseded.
  let afterSequence = 0;
  for (;;) {
    if (controller.signal.aborted || operation !== generation.current) {
      return;
    }
    if (operation === generation.current) {
      setModel({ ...openState, status: "streaming" });
    }
    let reply;
    try {
      reply = await client.readChunks(target, sourceVersion, afterSequence, controller.signal);
    } catch (error) {
      if (operation !== generation.current) return;
      if (controller.signal.aborted) {
        setModel({
          ...openState,
          status: "interrupted",
          canRetry: true,
          canRevealInFinder: false,
          canQuickLook: false,
          canOpenExternally: false,
        });
        return;
      }
      setModel(failureModel(error, target));
      return;
    }
    if (operation !== generation.current) return;

    if (reply.kind === "chunks") {
      if (reply.chunks.length === 0) {
        setModel({ ...openState, status: "ready" });
        return;
      }
      afterSequence = reply.chunks[reply.chunks.length - 1]!.sequence + 1;
      const accumulated = [...openState.chunks, ...reply.chunks];
      const nextState: PreviewControllerModel = {
        ...openState,
        chunks: accumulated,
        status: "streaming",
      };
      openState = nextState;
      setModel(nextState);
      const last = reply.chunks[reply.chunks.length - 1]!;
      if (last.isFinal) {
        setModel({ ...nextState, status: "ready" });
        return;
      }
      continue;
    }
    if (reply.kind === "interrupted") {
      setModel({
        ...openState,
        status: "interrupted",
        canRetry: reply.canRetry,
        canRevealInFinder: false,
        canQuickLook: false,
        canOpenExternally: false,
      });
      return;
    }
    if (reply.kind === "stale") {
      setModel({
        ...openState,
        status: "stale",
        canRetry: true,
        canRevealInFinder: false,
        canQuickLook: false,
        canOpenExternally: false,
      });
      return;
    }
    if (reply.kind === "unauthorized") {
      setModel({
        status: "unauthorized",
        target,
        chunks: [],
        canRetry: false,
        canRevealInFinder: false,
        canQuickLook: false,
        canOpenExternally: false,
      });
      return;
    }
    if (reply.kind === "unavailable") {
      setModel({
        status: "unavailable",
        target,
        chunks: [],
        canRetry: true,
        canRevealInFinder: false,
        canQuickLook: false,
        canOpenExternally: false,
      });
      return;
    }
    if (reply.kind === "unsupported") {
      setModel({
        status: "unsupported",
        target,
        chunks: [],
        canRetry: false,
        canRevealInFinder: false,
        canQuickLook: false,
        canOpenExternally: reply.canOpenExternally,
      });
      return;
    }
    // failed
    setModel({
      status: "failure",
      target,
      chunks: [],
      canRetry: true,
      canRevealInFinder: false,
      canQuickLook: false,
      canOpenExternally: false,
      message: reply.message ?? "Preview could not be read.",
    });
    return;
  }
}

function modelFromOutcome(outcome: PreviewOutcome, target: PreviewTarget): PreviewControllerModel {
  const base = { target, chunks: [] as ReadonlyArray<PreviewChunk> };
  switch (outcome.kind) {
    case "ready":
      return {
        ...base,
        status: "ready",
        manifest: outcome.manifest,
        manifestKind: outcome.manifest.kind,
        sourceVersion: outcome.manifest.sourceVersion,
        canRetry: false,
        canRevealInFinder: outcome.manifest.capabilities.canRevealInFinder,
        canQuickLook: outcome.manifest.capabilities.canQuickLook,
        canOpenExternally: outcome.manifest.capabilities.canOpenExternally,
      };
    case "limited-fidelity":
      return {
        ...base,
        status: "limited-fidelity",
        manifest: outcome.manifest,
        manifestKind: outcome.manifest.kind,
        sourceVersion: outcome.manifest.sourceVersion,
        canRetry: false,
        canRevealInFinder: outcome.manifest.capabilities.canRevealInFinder,
        canQuickLook: outcome.manifest.capabilities.canQuickLook,
        canOpenExternally: outcome.manifest.capabilities.canOpenExternally,
        message: outcome.manifest.fidelity.notice ?? "Preview is truncated.",
      };
    case "unauthorized":
      return {
        ...base,
        status: "unauthorized",
        canRetry: false,
        canRevealInFinder: false,
        canQuickLook: false,
        canOpenExternally: false,
      };
    case "unavailable":
      return {
        ...base,
        status: "unavailable",
        canRetry: true,
        canRevealInFinder: false,
        canQuickLook: false,
        canOpenExternally: false,
      };
    case "unsupported":
      return {
        ...base,
        status: "unsupported",
        canRetry: false,
        canRevealInFinder: false,
        canQuickLook: false,
        canOpenExternally: outcome.canOpenExternally,
        message: `Unsupported format${outcome.mediaType === undefined ? "" : ` (${outcome.mediaType})`}.`,
      };
    case "stale":
      return {
        ...base,
        status: "stale",
        canRetry: true,
        canRevealInFinder: false,
        canQuickLook: false,
        canOpenExternally: false,
      };
    case "too-large":
      return {
        ...base,
        status: "too-large",
        canRetry: false,
        canRevealInFinder: false,
        canQuickLook: false,
        canOpenExternally: outcome.canOpenExternally,
        message: `File is ${outcome.byteSize} bytes; preview limit is ${outcome.limit} bytes.`,
      };
    case "locked":
      return {
        ...base,
        status: "unauthorized",
        canRetry: false,
        canRevealInFinder: false,
        canQuickLook: false,
        canOpenExternally: outcome.canOpenExternally,
        message: "Preview is locked until access is approved.",
      };
    case "interrupted":
      return {
        ...base,
        status: "interrupted",
        canRetry: outcome.canRetry,
        canRevealInFinder: false,
        canQuickLook: false,
        canOpenExternally: false,
      };
    case "failed":
      return {
        ...base,
        status: "failure",
        canRetry: true,
        canRevealInFinder: false,
        canQuickLook: false,
        canOpenExternally: false,
        message: outcome.message ?? "Preview could not be read.",
      };
  }
}

function failureModel(error: unknown, target: PreviewTarget): PreviewControllerModel {
  if (error instanceof PreviewClientFailure) {
    if (error.status === 401) {
      return {
        status: "unauthorized",
        target,
        chunks: [],
        canRetry: false,
        canRevealInFinder: false,
        canQuickLook: false,
        canOpenExternally: false,
      };
    }
    return {
      status: "failure",
      target,
      chunks: [],
      canRetry: true,
      canRevealInFinder: false,
      canQuickLook: false,
      canOpenExternally: false,
      message: error.message,
    };
  }
  return {
    status: "failure",
    target,
    chunks: [],
    canRetry: true,
    canRevealInFinder: false,
    canQuickLook: false,
    canOpenExternally: false,
    message: "Preview is unavailable.",
  };
}
