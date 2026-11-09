import { Effect } from "effect";
import type { ProviderFileReviewRead } from "@octant/contracts/provider-file-review";
import { ProviderFileReviewPath } from "@octant/contracts/provider-file-review";
import { Schema } from "effect";
import type { CodeThread, WindowId } from "@octant/contracts";
import type {
  CodeProviderFileReviewRequest,
  CodeProviderFileReviewRead,
} from "@octant/contracts/code-provider-file-review";
import type { CodeOperationRuntimeOptions } from "./codeOperationRuntime";
import { liveCodeTestSourcePort } from "./codeDirectoryPort";
import { joinCodePath, parentCodePath, resolveContainedPath } from "./codePathConfinement";
import { secretGuardRefusal } from "../process/secretGuard";
import type {
  ProviderAcquireInput,
  ProviderDriver,
  ProviderSessionResume,
} from "@octant/provider-sdk/driver";

export interface CodeProviderFileReviewSession {
  readonly driver: ProviderDriver;
  readonly acquire: ProviderAcquireInput;
  readonly resume: ProviderSessionResume;
  readonly path: string;
  readonly scopeId?: string;
  readonly current: () => boolean;
}

type Source = {
  readonly thread: CodeThread;
  readonly sessionId: ProviderSessionResume["sessionId"];
  readonly resumeCursor: ProviderSessionResume["resumeCursor"];
};

/** Host authority and the session lease stay outside every provider adapter. */
export function createCodeProviderFileReview(options: {
  readonly host: Pick<
    CodeOperationRuntimeOptions,
    | "persistence"
    | "windowAccess"
    | "resolveCheckoutRoot"
    | "resolveProviderDriver"
    | "isProviderModelAllowed"
    | "acpPathPort"
  >;
  readonly source: (threadId: CodeThread["id"]) => Source | undefined;
  readonly busy: (threadId: CodeThread["id"]) => boolean;
  readonly leases: Set<string>;
}) {
  return async (
    windowId: WindowId,
    request: CodeProviderFileReviewRequest,
    admissionCurrent: () => boolean,
    signal?: AbortSignal,
  ): Promise<CodeProviderFileReviewRead> => {
    const { host } = options;
    const deadline = Date.now() + 20_000;
    let timedOut = false;
    const wait = async <T>(value: PromiseLike<T> | T): Promise<T> => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          Promise.resolve(value),
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => {
                timedOut = true;
                reject(new Error("Provider read deadline"));
              },
              Math.max(0, deadline - Date.now()),
            );
          }),
        ]);
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    };
    const thread = host.persistence.readCodeThread(request.threadId);
    const access = host.windowAccess.currentProjectAccess;
    const refused = (
      reason: Extract<ProviderFileReviewRead, { status: "refused" }>["reason"],
    ): ProviderFileReviewRead => ({ status: "refused", reason });
    if (
      thread === undefined ||
      access === undefined ||
      !admissionCurrent() ||
      signal?.aborted ||
      !(await wait(host.windowAccess.canAccessProject(windowId, thread.projectId)).catch(
        () => false,
      ))
    )
      return refused("unauthorized");
    const threadIdentity = JSON.stringify(thread);
    const current = () =>
      Date.now() < deadline &&
      admissionCurrent() &&
      !signal?.aborted &&
      access(windowId, thread.projectId) &&
      JSON.stringify(host.persistence.readCodeThread(thread.id)) === threadIdentity &&
      host.isProviderModelAllowed?.(thread) !== false;
    if (!current() || String(thread.checkoutId) !== String(request.checkoutId))
      return refused("stale");
    const driver = await wait(host.resolveProviderDriver(thread)).catch(() => undefined);
    if (!current()) return refused("stale");
    if (driver?.fileReviewReads !== true) return refused("unsupported");
    if (request.kind === "availability") return { status: "available" };
    if (!Schema.is(ProviderFileReviewPath)(request.path)) return refused("path-refused");
    if (options.busy(thread.id) || options.leases.has(String(thread.id)))
      return refused("turn-running");
    options.leases.add(String(thread.id));
    try {
      const found = options.source(thread.id);
      const binding = found?.resumeCursor.binding;
      if (found === undefined || binding === undefined) return refused("no-session");
      const checkout = host.persistence.readCodeCheckout(request.checkoutId);
      if (
        checkout === undefined ||
        checkout.kind === "remote-root" ||
        checkout.availability !== "available"
      )
        return refused("unavailable");
      const checkoutIdentity = JSON.stringify(checkout);
      const sourceIdentity = JSON.stringify(found);
      const identityCurrent = () =>
        current() &&
        !options.busy(thread.id) &&
        JSON.stringify(options.source(thread.id)) === sourceIdentity &&
        JSON.stringify(host.persistence.readCodeCheckout(request.checkoutId)) === checkoutIdentity;
      const root = await wait(host.resolveCheckoutRoot(windowId, thread, checkout));
      if (
        !identityCurrent() ||
        root === undefined ||
        root === null ||
        root.rootCurrent?.() === false
      )
        return refused("stale");
      const providerRoot =
        thread.workingFolderId === undefined ? root.checkoutRoot : root.workingDirectory;
      if (
        providerRoot === undefined ||
        binding.projectRoot !== providerRoot ||
        binding.mode !== "code" ||
        String(binding.instanceId) !== String(thread.providerInstanceId) ||
        String(binding.sessionId) !== String(found.sessionId) ||
        String(binding.modelId) !== String(thread.modelId) ||
        found.resumeCursor.driverKind !== driver.kind
      )
        return refused("stale");
      const paths = host.acpPathPort ?? liveCodeTestSourcePort;
      const pathRead = async <A>(read: () => Promise<A>): Promise<A> => {
        if (!identityCurrent()) throw new Error("Code file admission changed");
        const answer = await wait(read());
        if (!identityCurrent()) throw new Error("Code file admission changed");
        return answer;
      };
      const pathPort = {
        realpath: (path: string) => pathRead(() => paths.realpath(path)),
        lstat: (path: string) => pathRead(() => paths.lstat(path)),
        stat: (path: string) => pathRead(() => paths.stat(path)),
        readlink: (path: string) => pathRead(() => paths.readlink(path)),
      };
      const canonicalRoot = await pathPort.realpath(providerRoot).catch(() => undefined);
      if (!identityCurrent() || canonicalRoot === undefined || canonicalRoot !== providerRoot)
        return refused("path-refused");
      const absolute = joinCodePath(root.checkoutRoot, request.path);
      // The session is never reopened at a wider root to serve a file outside
      // its working-folder binding. Deleted files still need a contained parent.
      const pathProof = async () => {
        if (
          !identityCurrent() ||
          root.rootCurrent?.() === false ||
          secretGuardRefusal(absolute) !== undefined
        )
          return undefined;
        const existing = await resolveContainedPath(pathPort, canonicalRoot, absolute);
        if (!identityCurrent()) return undefined;
        if (existing !== undefined)
          return existing.stat.isFile && secretGuardRefusal(existing.canonical) === undefined
            ? JSON.stringify(existing)
            : undefined;
        try {
          await pathPort.lstat(absolute);
          return undefined;
        } catch (error) {
          if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT")
            return undefined;
        }
        const parent = await resolveContainedPath(
          pathPort,
          canonicalRoot,
          parentCodePath(absolute),
        );
        if (
          !identityCurrent() ||
          parent?.stat.isDirectory !== true ||
          secretGuardRefusal(parent.canonical) !== undefined
        )
          return undefined;
        return JSON.stringify({ missing: absolute, parent });
      };
      const proof = await pathProof();
      if (proof === undefined || !identityCurrent()) return refused("path-refused");
      const relativePath = absolute.slice(canonicalRoot.length + 1);
      if (
        !Schema.is(ProviderFileReviewPath)(relativePath) ||
        !absolute.startsWith(`${canonicalRoot}/`)
      )
        return refused("path-refused");
      const answer = await readCodeProviderFileReviewSession(
        {
          driver,
          acquire: {
            instanceId: thread.providerInstanceId,
            mode: "code",
            projectRoot: providerRoot,
          },
          resume: {
            sessionId: found.sessionId,
            resumeCursor: found.resumeCursor,
            executionPolicy: "plan",
            modelId: thread.modelId,
            ...(thread.modelOptionValues === undefined
              ? {}
              : { modelOptionValues: thread.modelOptionValues }),
            tools: [],
          },
          path: relativePath,
          ...(request.scopeId === undefined ? {} : { scopeId: request.scopeId }),
          current: () =>
            identityCurrent() &&
            root.rootCurrent?.() !== false &&
            secretGuardRefusal(absolute) === undefined,
        },
        signal,
      );
      if (!identityCurrent() || (await pathProof()) !== proof || !identityCurrent())
        return refused("stale");
      // The wire path names the selected checkout file, even when the native
      // session names it relative to a narrower working folder.
      return answer.status === "ready"
        ? { ...answer, file: { ...answer.file, path: request.path } }
        : answer;
    } catch {
      return refused(signal?.aborted ? "cancelled" : timedOut ? "timeout" : "unavailable");
    } finally {
      options.leases.delete(String(thread.id));
    }
  };
}

/** Reads only a host-recorded session, then releases its private connection. */
export async function readCodeProviderFileReviewSession(
  input: CodeProviderFileReviewSession,
  signal?: AbortSignal,
): Promise<ProviderFileReviewRead> {
  const controller = new AbortController();
  const cancelled = () => controller.abort();
  signal?.addEventListener("abort", cancelled, { once: true });
  if (signal?.aborted) controller.abort();
  const current = () => !controller.signal.aborted && input.current();
  const stale = (): ProviderFileReviewRead => ({
    status: "refused",
    reason: signal?.aborted ? "cancelled" : "stale",
  });
  const program = Effect.gen(function* () {
    if (!current()) return stale();
    if (input.driver.fileReviewReads !== true)
      return { status: "refused", reason: "unsupported" } as const;
    const connection = yield* input.driver.acquire({
      instanceId: input.acquire.instanceId,
      projectRoot: input.acquire.projectRoot,
      mode: "code",
      extraFolders: [],
    });
    // Register cleanup before checking a late acquire's authority. Resume can
    // partially open a native session even when it subsequently refuses.
    yield* Effect.addFinalizer(() =>
      connection.stop(input.resume.sessionId).pipe(
        Effect.timeoutOption(3_000),
        Effect.catchAllCause(() => Effect.void),
      ),
    );
    if (!current()) return stale();
    const read = connection.readFileReview;
    if (read === undefined) return { status: "refused", reason: "unsupported" } as const;
    const resumed = yield* connection
      .resume({
        ...input.resume,
        // A read never inherits Full access or native startup code from the
        // task it inspects. Plan also confines writes and child execution.
        executionPolicy: "plan",
        current,
        autoApprove: false,
        tools: [],
        nativeSetup: {
          subagents: false,
          webTools: false,
          skills: false,
          toolServers: false,
          hooks: false,
          projectCode: false,
        },
      })
      .pipe(Effect.catchAll(() => Effect.succeed(undefined)));
    if (!current()) return stale();
    if (resumed === undefined || String(resumed.sessionId) !== String(input.resume.sessionId))
      return { status: "refused", reason: "cold-unavailable" } as const;
    const answer = yield* read({
      sessionId: input.resume.sessionId,
      path: input.path,
      ...(input.scopeId === undefined ? {} : { scopeId: input.scopeId }),
      signal: controller.signal,
      current,
    });
    return current() ? answer : stale();
  });
  try {
    return await Effect.runPromise(
      program.pipe(
        Effect.timeout(12_000),
        Effect.catchTag("TimeoutException", () => {
          return Effect.succeed({ status: "refused", reason: "timeout" } as const);
        }),
        Effect.catchAllCause(() =>
          Effect.succeed(
            signal?.aborted
              ? ({ status: "refused", reason: "cancelled" } as const)
              : ({ status: "refused", reason: "unavailable" } as const),
          ),
        ),
        Effect.scoped,
      ),
      { signal: controller.signal },
    );
  } catch {
    return { status: "refused", reason: signal?.aborted ? "cancelled" : "unavailable" };
  } finally {
    controller.abort();
    signal?.removeEventListener("abort", cancelled);
  }
}
