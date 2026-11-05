import type { CodeClient } from "@octant/client-runtime/code-client";
import {
  decodeCodeOperationCommand,
  decodeCodeOperationId,
  decodeCodeReviewFindingId,
  type CodeCheckoutId,
  type CodeThreadId,
  type CodeOperationId,
  type CodeOperationResult,
  type CodeReviewTarget,
  type CodeReviewFindingAssessment,
  type CodeRepositoryTestStatus,
  type ProviderExecutionPolicy,
} from "@octant/contracts";
import { useEffect, useRef, useState } from "react";
import { composerThreadDrafts } from "../composer/composerThreadDraftStore";
import { OctantAlert } from "../ui/base/OctantAlert";
import { OctantButton } from "../ui/base/OctantButton";
import { CodeReviewPane } from "./CodeReviewPane";

export interface CodeReviewLineSelection {
  readonly reviewOperationId: CodeOperationId;
  readonly captureCursor?: number;
  readonly path: string;
  readonly side: "original" | "modified";
  readonly line: number;
}

/** A finite UI wait also rejects a transport that ignores cancellation. */
export async function readLocalReview<T>(
  read: (signal: AbortSignal) => Promise<T>,
  owner: AbortSignal,
): Promise<T> {
  const controller = new AbortController();
  const stop = () => controller.abort();
  owner.addEventListener("abort", stop, { once: true });
  if (owner.aborted) controller.abort();
  const deadline = setTimeout(stop, 20_000);
  let removeAbort = () => {};
  const stopped = new Promise<never>((_resolve, reject) => {
    const refuse = () => reject(new Error("Local review is unavailable. Refresh before retrying."));
    controller.signal.addEventListener("abort", refuse, { once: true });
    removeAbort = () => controller.signal.removeEventListener("abort", refuse);
    if (controller.signal.aborted) refuse();
  });
  try {
    return await Promise.race([read(controller.signal), stopped]);
  } finally {
    clearTimeout(deadline);
    removeAbort();
    owner.removeEventListener("abort", stop);
  }
}

interface CodeLocalReviewProps {
  readonly client: CodeClient;
  readonly scope: { readonly threadId: CodeThreadId; readonly checkoutId: CodeCheckoutId };
  readonly executionPolicy: ProviderExecutionPolicy;
  readonly line?: CodeReviewLineSelection;
  readonly createUuid?: () => string;
  readonly onRefreshComparison?: () => void;
}

export function CodeLocalReview(props: CodeLocalReviewProps) {
  const client = useRef({ value: props.client, generation: 0 });
  if (client.current.value !== props.client)
    client.current = { value: props.client, generation: client.current.generation + 1 };
  return (
    <BoundCodeLocalReview
      key={`${props.scope.threadId}:${props.scope.checkoutId}:${client.current.generation}`}
      {...props}
    />
  );
}

function BoundCodeLocalReview(props: CodeLocalReviewProps) {
  const [assessments, setAssessments] = useState<ReadonlyArray<CodeReviewFindingAssessment>>([]);
  const [target, setTarget] = useState<CodeReviewTarget>();
  const [targetNotice, setTargetNotice] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [refresh, setRefresh] = useState(0);
  const [checks, setChecks] = useState<CodeRepositoryTestStatus>();
  const [preparing, setPreparing] = useState(false);
  const preparingRef = useRef(false);
  const owner = useRef(new AbortController());
  const identity = `${props.scope.threadId}:${props.scope.checkoutId}`;
  const current = useRef({ identity, client: props.client });
  current.current = { identity, client: props.client };
  const uuid = () => props.createUuid?.() ?? globalThis.crypto.randomUUID();
  const nextOperation = () => decodeCodeOperationId(uuid());

  useEffect(() => {
    const controller = new AbortController();
    owner.current.abort();
    owner.current = controller;
    return () => controller.abort();
  }, [identity, props.client]);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    void readLocalReview(
      (signal) =>
        props.client.executeOperation(
          {
            kind: "list-review-findings",
            operationId: decodeCodeOperationId(
              props.createUuid?.() ?? globalThis.crypto.randomUUID(),
            ),
            ...props.scope,
          },
          signal,
        ),
      controller.signal,
    )
      .then((result) => {
        if (controller.signal.aborted) return;
        if (
          result.kind !== "review-findings-state" ||
          result.threadId !== props.scope.threadId ||
          result.checkoutId !== props.scope.checkoutId
        )
          throw new Error("Local findings are unavailable for this task and checkout.");
        setAssessments(result.findings);
        if (result.truncated)
          setNotice(
            "Only the newest bounded list of findings is shown. Other findings were omitted.",
          );
      })
      .catch(() => {
        if (!controller.signal.aborted)
          setNotice("Local findings could not be loaded. Refresh to retry.");
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    const readChecks = props.client.readTestStatus;
    setChecks(undefined);
    if (readChecks !== undefined)
      void readLocalReview(
        (signal) =>
          readChecks.call(props.client, props.scope.threadId, props.scope.checkoutId, signal),
        controller.signal,
      )
        .then((result) => {
          if (
            !controller.signal.aborted &&
            result.threadId === props.scope.threadId &&
            result.checkoutId === props.scope.checkoutId
          )
            setChecks(result);
        })
        .catch(() => undefined);
    return () => controller.abort();
  }, [identity, props.client, props.createUuid, refresh]);

  const line = props.line;
  useEffect(() => {
    setTarget(undefined);
    setTargetNotice(undefined);
    if (line === undefined) return;
    const controller = new AbortController();
    void readLocalReview(
      (signal) =>
        props.client.executeOperation(
          decodeCodeOperationCommand({
            kind: "prepare-review-target",
            operationId: decodeCodeOperationId(
              props.createUuid?.() ?? globalThis.crypto.randomUUID(),
            ),
            ...props.scope,
            ...line,
          }),
          signal,
        ),
      controller.signal,
    )
      .then((result) => {
        if (controller.signal.aborted) return;
        if (result.kind !== "review-target-state")
          throw new Error(
            "This captured line is unavailable. Refresh the comparison and select it again.",
          );
        setTarget(result.target);
        setTargetNotice(result.explanation);
      })
      .catch(() => {
        if (!controller.signal.aborted)
          setTargetNotice(
            "This captured line is unavailable. Refresh the comparison and select it again. Binary files and uncaptured lines cannot receive a line finding.",
          );
      });
    return () => controller.abort();
  }, [identity, props.client, props.createUuid, line]);

  const boundedClient = {
    executeOperation: (
      command: Parameters<CodeClient["executeOperation"]>[0],
    ): Promise<CodeOperationResult> =>
      readLocalReview(
        (signal) => props.client.executeOperation(command, signal),
        owner.current.signal,
      ),
  };
  return (
    <section aria-label="Review findings and correction draft">
      <OctantButton
        type="button"
        size="sm"
        variant="secondary"
        onClick={() => {
          setRefresh((value) => value + 1);
          props.onRefreshComparison?.();
        }}
      >
        Refresh findings and checks
      </OctantButton>
      <p role="status">
        {checks?.result === undefined
          ? "No recorded test result is available for this task."
          : `Latest recorded checks: ${checks.result.state}${checks.result.state !== "completed" ? "" : ` · ${checks.result.verdict}`}. This result is not bound to the displayed comparison; recheck Tests after the correction turn.`}
      </p>
      {loading ? <p role="status">Loading local findings…</p> : null}
      {targetNotice === undefined ? null : <OctantAlert tone="neutral">{targetNotice}</OctantAlert>}
      <CodeReviewPane
        client={boundedClient}
        scope={props.scope}
        executionPolicy={props.executionPolicy}
        findings={assessments.map((item) => item.finding)}
        assessments={assessments}
        createFindingId={() => decodeCodeReviewFindingId(uuid())}
        createOperationId={nextOperation}
        {...(target === undefined ||
        line === undefined ||
        target.anchor.reviewOperationId !== line.reviewOperationId ||
        target.path !== line.path ||
        target.anchor.side !== line.side ||
        target.location.kind !== "line" ||
        target.location.line !== line.line
          ? {}
          : {
              target: {
                fileId: target.fileId,
                fileDigest: target.fileDigest,
                path: target.path,
                line: target.location.line,
                anchor: target.anchor,
              },
            })}
        onFindingChanged={() => setRefresh((value) => value + 1)}
        preparingCorrection={preparing}
        onPrepareCorrection={async (findings) => {
          if (preparingRef.current) return;
          preparingRef.current = true;
          setPreparing(true);
          setNotice(undefined);
          const sameScope = () =>
            current.current.identity === identity &&
            current.current.client === props.client &&
            !owner.current.signal.aborted;
          try {
            const result = await readLocalReview(
              (signal) =>
                props.client.executeOperation(
                  decodeCodeOperationCommand({
                    kind: "prepare-review-correction",
                    operationId: nextOperation(),
                    ...props.scope,
                    findings,
                  }),
                  signal,
                ),
              owner.current.signal,
            );
            if (!sameScope()) return;
            if (
              result.kind !== "review-correction-prepared" ||
              result.prepared.threadId !== props.scope.threadId ||
              result.prepared.checkoutId !== props.scope.checkoutId
            )
              throw new Error("unavailable");
            const saved = composerThreadDrafts.appendReviewCorrection(result.prepared);
            setNotice(
              saved.status === "refused"
                ? saved.message
                : saved.status === "unpersisted"
                  ? "Added to this task’s draft in this window, but it could not be saved. Nothing was sent or queued."
                  : "Added to this task’s saved draft. Existing text is kept. Open its composer to edit and send when ready; nothing was sent, queued or approved.",
            );
          } catch {
            if (sameScope())
              setNotice(
                "The correction draft could not be prepared. Refresh the findings and select them again. Nothing was added or sent.",
              );
          } finally {
            preparingRef.current = false;
            if (sameScope()) setPreparing(false);
          }
        }}
      />
      {notice === undefined ? null : <OctantAlert tone="neutral">{notice}</OctantAlert>}
    </section>
  );
}
