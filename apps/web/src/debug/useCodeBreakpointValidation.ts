import type { CodeClient } from "@octant/client-runtime/code-client";
import type { CodeCheckoutId, CodeRelativePath, CodeThreadId } from "@octant/contracts/code";
import type { ProjectId } from "@octant/contracts/projects";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  CodeBreakpointFileObservation,
  CodeBreakpointUnresolvedReason,
  CodeDebugWindowState,
} from "./codeDebugWindowState";

type FileClient = Pick<CodeClient, "openFile" | "content">;
type Reading =
  | { readonly status: "read"; readonly observation: CodeBreakpointFileObservation }
  | { readonly status: "unresolved"; readonly reason: CodeBreakpointUnresolvedReason };
const MAX_VALIDATION_BYTES = 5 * 1024 * 1024;

/** Reads only selected saved files through the existing authorized Code routes. */
async function readLocation(
  client: FileClient,
  threadId: CodeThreadId,
  checkoutId: CodeCheckoutId,
  projectId: ProjectId,
  path: CodeRelativePath,
  signal: AbortSignal,
  deadline: number,
): Promise<Reading> {
  const stopped: Reading = { status: "unresolved", reason: "unavailable" };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) controller.abort();
  const operation = async (): Promise<Reading> => {
    const file = await client.openFile(threadId, checkoutId, path);
    if (controller.signal.aborted || performance.now() >= deadline) return stopped;
    if (file.status !== "editable")
      return {
        status: "unresolved",
        reason:
          file.status === "failed" && ["not-found", "notFound"].includes(file.failure.code)
            ? "missing"
            : "unavailable",
      };
    if (
      file.metadata.byteLength > MAX_VALIDATION_BYTES ||
      file.content.byteLength > MAX_VALIDATION_BYTES ||
      file.content.digest !== file.metadata.digest ||
      file.content.truncated
    )
      return stopped;
    // CodeClient.content verifies the immutable content response's length and
    // SHA-256; CodeFileService binds that reference to the verified read metadata.
    const bytes = await client.content(file.content.contentId);
    if (
      controller.signal.aborted ||
      performance.now() >= deadline ||
      bytes.byteLength !== file.metadata.byteLength ||
      bytes.byteLength > MAX_VALIDATION_BYTES
    )
      return stopped;
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return {
      status: "read",
      observation: {
        projectId,
        fileId: file.fileId,
        metadata: file.metadata,
        lineCount: text.split("\n").length,
        clean: true,
      },
    };
  };
  try {
    return await Promise.race([
      operation().catch(() => stopped),
      new Promise<Reading>((resolve) => {
        controller.signal.addEventListener("abort", () => resolve(stopped), { once: true });
        timer = setTimeout(() => controller.abort(), Math.max(0, deadline - performance.now()));
        if (controller.signal.aborted) resolve(stopped);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", abort);
    controller.abort();
  }
}

export function useCodeBreakpointValidation(options: {
  readonly client?: FileClient;
  readonly store: CodeDebugWindowState;
  readonly threadKey: string;
  readonly threadId: CodeThreadId;
  readonly checkoutId: CodeCheckoutId;
  readonly projectId?: ProjectId;
  readonly enabled: boolean;
  readonly waitMs?: number;
}) {
  const identity = useMemo(
    () => ({
      client: options.client,
      projectId: options.projectId,
      enabled: options.enabled,
      key: options.threadKey,
      store: options.store,
    }),
    [options.client, options.projectId, options.enabled, options.threadKey, options.store],
  );
  const current = useRef(identity);
  current.current = identity;
  const lifetime = useRef<AbortController | undefined>(undefined);
  const [revision, setRevision] = useState(0);
  const [pending, setPending] = useState<{
    readonly identity: typeof identity;
    readonly paths: ReadonlySet<CodeRelativePath>;
  }>();
  const validate = useCallback(
    async (
      path: CodeRelativePath,
      reaccept: boolean,
      signal: AbortSignal,
      deadline = performance.now() + (options.waitMs ?? 15000),
    ): Promise<boolean> => {
      const { client, projectId, enabled, key, store } = identity;
      if (client === undefined || projectId === undefined || !enabled || signal.aborted)
        return false;
      const before = store.read(key);
      const lines = before.breakpoints.get(path);
      const file = before.breakpointFiles?.get(path);
      if (lines === undefined || performance.now() >= deadline) return false;
      setPending((previous) => ({
        identity,
        paths: new Set([...(previous?.identity === identity ? previous.paths : []), path]),
      }));
      try {
        let reading = await readLocation(
          client,
          options.threadId,
          options.checkoutId,
          projectId,
          path,
          signal,
          deadline,
        );
        if (
          signal.aborted ||
          current.current !== identity ||
          store.read(key).breakpoints.get(path) !== lines ||
          store.read(key).breakpointFiles?.get(path) !== file
        )
          return false;
        // Timers can run late in a suspended/background renderer. Elapsed time,
        // not delivery of the timeout callback, decides whether bytes may count.
        if (performance.now() >= deadline)
          reading = { status: "unresolved", reason: "unavailable" };
        store.observeFile(
          key,
          path,
          reading.status === "read" ? reading.observation : undefined,
          reading.status === "unresolved" ? reading.reason : undefined,
        );
        return reaccept && reading.status === "read" && performance.now() < deadline
          ? store.reacceptFile(key, path)
          : reading.status === "read";
      } finally {
        if (!signal.aborted && current.current === identity)
          setPending((previous) => {
            if (previous?.identity !== identity) return previous;
            const paths = new Set(previous.paths);
            paths.delete(path);
            return { identity, paths };
          });
      }
    },
    [identity, options.threadId, options.checkoutId, options.waitMs],
  );
  const revalidate = useCallback(
    async (signal: AbortSignal) => {
      if (signal.aborted) return;
      const paths = [...identity.store.read(identity.key).breakpoints.keys()];
      // Losing the current authorized Project/file reader must not leave an
      // earlier verified observation executable through a later Start.
      for (const path of paths)
        identity.store.observeFile(identity.key, path, undefined, "not-checked");
      if (!identity.enabled || identity.client === undefined || identity.projectId === undefined)
        return;
      const controller = new AbortController();
      const abort = () => controller.abort();
      signal.addEventListener("abort", abort, { once: true });
      const expiresAt = performance.now() + (options.waitMs ?? 15000);
      const timer = setTimeout(abort, options.waitMs ?? 15000);
      let next = 0;
      try {
        await Promise.all(
          Array.from({ length: Math.min(4, paths.length) }, async () => {
            while (!controller.signal.aborted && performance.now() < expiresAt) {
              const path = paths[next++];
              if (path === undefined) return;
              await validate(path, false, controller.signal, expiresAt);
            }
          }),
        );
      } finally {
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
        controller.abort();
        if (!signal.aborted && current.current === identity)
          setPending({ identity, paths: new Set() });
      }
    },
    [identity, validate, options.waitMs],
  );
  useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    void revalidate(controller.signal);
    return () => controller.abort();
  }, [identity, revalidate, revision]);
  const revalidateCurrent = useCallback(() => {
    const signal = lifetime.current?.signal;
    return signal === undefined ? Promise.resolve() : revalidate(signal);
  }, [revalidate]);
  return {
    pending: pending?.identity === identity ? pending.paths : new Set<CodeRelativePath>(),
    refresh: () => setRevision((value) => value + 1),
    revalidate: revalidateCurrent,
    reaccept: (path: CodeRelativePath) => {
      const signal = lifetime.current?.signal;
      return signal === undefined ? Promise.resolve(false) : validate(path, true, signal);
    },
  };
}
