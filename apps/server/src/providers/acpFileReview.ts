import { Schema } from "effect";
import {
  MAX_PROVIDER_FILE_REVIEW_ANCHORS,
  MAX_PROVIDER_FILE_REVIEW_SCOPES,
  MAX_PROVIDER_FILE_REVIEW_TEXT,
  ProviderFileReviewPath,
  decodeProviderFileReviewRead,
  type ProviderFileReviewRead,
} from "@octant/contracts/provider-file-review";

const owner = Schema.Union(
  Schema.Struct({
    kind: Schema.Literal("agent"),
    turnId: Schema.Int.pipe(Schema.between(0, 2_147_483_647)),
  }),
  Schema.Struct({
    kind: Schema.Literal("manual"),
    index: Schema.Int.pipe(Schema.between(0, 2_147_483_646)),
  }),
);
const nativePath = Schema.String.pipe(Schema.maxLength(4_096));
const state = Schema.Struct({
  files: Schema.Array(Schema.Struct({ path: nativePath })).pipe(Schema.maxItems(1_024)),
  scopes: Schema.Array(
    Schema.Struct({
      owner,
      files: Schema.Array(Schema.Struct({ path: nativePath })).pipe(Schema.maxItems(1_024)),
    }),
  ).pipe(Schema.maxItems(MAX_PROVIDER_FILE_REVIEW_SCOPES)),
});
const baseline = Schema.Struct({
  content: Schema.String.pipe(Schema.maxLength(MAX_PROVIDER_FILE_REVIEW_TEXT)),
});
const diff = Schema.Struct({
  status: Schema.Literal("modified", "created", "deleted", "binary_or_undecodable"),
  baseline: Schema.String.pipe(Schema.maxLength(MAX_PROVIDER_FILE_REVIEW_TEXT)),
  current: Schema.String.pipe(Schema.maxLength(MAX_PROVIDER_FILE_REVIEW_TEXT)),
});
const hunks = Schema.Struct({
  hunks: Schema.Array(
    Schema.Struct({
      side: Schema.Literal("additions", "deletions"),
      line: Schema.Int.pipe(Schema.between(0, 2_147_483_646)),
    }),
  ).pipe(Schema.maxItems(MAX_PROVIDER_FILE_REVIEW_ANCHORS)),
});
const decodeState = Schema.decodeUnknownEither(state);
const decodeBaseline = Schema.decodeUnknownEither(baseline);
const decodeDiff = Schema.decodeUnknownEither(diff);
const decodeHunks = Schema.decodeUnknownEither(hunks);
const validPath = Schema.is(ProviderFileReviewPath);
type Refused = Extract<ProviderFileReviewRead, { readonly status: "refused" }>;
const refused = (reason: Refused["reason"]): Refused => ({ status: "refused", reason });
const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

export interface AcpFileReviewRead {
  readonly runtimeVersion: string;
  readonly sourceSessionId: string;
  readonly path: string;
  readonly root?: string;
  readonly scopeId?: string;
  readonly signal?: AbortSignal;
  readonly current: () => boolean;
  readonly call: (method: string, params: Readonly<Record<string, unknown>>) => Promise<unknown>;
}

/** Exact native read dialect; no approve/revert, prompt or session creation lives here. */
export async function readAcpFileReview(input: AcpFileReviewRead): Promise<ProviderFileReviewRead> {
  if (input.runtimeVersion !== "3.0.3") return refused("unsupported");
  if (!validPath(input.path)) return refused("path-refused");
  if (input.sourceSessionId.length === 0) return refused("no-session");
  const deadline = Date.now() + 8_000;
  const current = (): Refused | undefined =>
    input.signal?.aborted === true
      ? refused("cancelled")
      : !input.current()
        ? refused("stale")
        : undefined;
  const call = async (
    method: "_review/state" | "_review/hunks" | "_review/baseline" | "_review/turnDiff",
    parameters: Readonly<Record<string, unknown>>,
  ): Promise<{ readonly status: "value"; readonly value: unknown } | Refused> => {
    const invalid = current();
    if (invalid !== undefined) return invalid;
    const remaining = deadline - Date.now();
    if (remaining <= 0) return refused("timeout");
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let abort: (() => void) | undefined;
    try {
      const stopped = new Promise<Refused>((resolve) => {
        timeout = setTimeout(() => resolve(refused("timeout")), remaining);
        abort = () => resolve(refused("cancelled"));
        input.signal?.addEventListener("abort", abort, { once: true });
      });
      const answer = await Promise.race([
        Promise.resolve().then(async () => {
          const invalid = current();
          if (invalid !== undefined) return invalid;
          try {
            const value = await input.call(method, {
              sessionId: input.sourceSessionId,
              ...parameters,
            });
            return { status: "value", value } as const;
          } catch {
            return refused("unavailable");
          }
        }),
        stopped,
      ]);
      return current() ?? answer;
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
      if (abort !== undefined) input.signal?.removeEventListener("abort", abort);
    }
  };
  // A native read can reconcile manual tracking metadata. Read the resulting
  // owner list afterwards rather than inventing an agent owner for that edit.
  const firstHunks = await call("_review/hunks", { path: input.path });
  if (firstHunks.status === "refused") return firstHunks;
  if (decodeHunks(firstHunks.value)._tag === "Left") return refused("malformed");
  const stateRead = await call("_review/state", {});
  if (stateRead.status === "refused") return stateRead;
  const decodedState = decodeState(stateRead.value);
  if (decodedState._tag === "Left") return refused("malformed");
  const selectedPath = (path: string) =>
    path === input.path ||
    (input.root !== undefined && path === `${input.root.replace(/\/$/, "")}/${input.path}`);
  const scopes = decodedState.right.scopes
    .filter((scope) => scope.files.some((file) => selectedPath(file.path)))
    .map((scope) => ({
      nativeOwner: scope.owner,
      id:
        scope.owner.kind === "agent"
          ? `native-turn:${scope.owner.turnId}`
          : `manual:${scope.owner.index}`,
      label:
        scope.owner.kind === "agent"
          ? `Provider turn ${scope.owner.turnId}`
          : `Manual edit ${scope.owner.index + 1}`,
      source: scope.owner.kind === "agent" ? ("provider-turn" as const) : ("manual-edit" as const),
    }));
  if (new Set(scopes.map((scope) => scope.id)).size !== scopes.length) return refused("malformed");
  const selected =
    input.scopeId === undefined
      ? scopes.at(-1)
      : scopes.find((scope) => scope.id === input.scopeId);
  if (input.scopeId !== undefined && selected === undefined) return refused("stale");
  const baseRead = await call("_review/baseline", { path: input.path });
  if (baseRead.status === "refused") return baseRead;
  if (
    isRecord(baseRead.value) &&
    typeof baseRead.value.content === "string" &&
    baseRead.value.content.length > MAX_PROVIDER_FILE_REVIEW_TEXT
  )
    return refused("too-large");
  const decodedBase = decodeBaseline(baseRead.value);
  if (decodedBase._tag === "Left") return refused("malformed");
  const normalizedScopes = scopes.map(({ id, label, source }) => ({ id, label, source }));
  if (selected === undefined)
    return {
      status: "ready",
      file: {
        path: input.path,
        checkpoint: decodedBase.right.content,
        scopes: normalizedScopes,
        anchors: [],
      },
    };
  const scopedRead = await call("_review/turnDiff", {
    path: input.path,
    owner: selected.nativeOwner,
  });
  if (scopedRead.status === "refused") return scopedRead;
  if (
    isRecord(scopedRead.value) &&
    [scopedRead.value.baseline, scopedRead.value.current].some(
      (text) => typeof text === "string" && text.length > MAX_PROVIDER_FILE_REVIEW_TEXT,
    )
  )
    return refused("too-large");
  const decodedDiff = decodeDiff(scopedRead.value);
  if (decodedDiff._tag === "Left") return refused("malformed");
  const scopedHunks = await call("_review/hunks", {
    path: input.path,
    owner: selected.nativeOwner,
  });
  if (scopedHunks.status === "refused") return scopedHunks;
  const decodedHunks = decodeHunks(scopedHunks.value);
  if (decodedHunks._tag === "Left") return refused("malformed");
  return (
    current() ??
    decodeProviderFileReviewRead({
      status: "ready",
      file: {
        path: input.path,
        checkpoint: decodedBase.right.content,
        scopes: normalizedScopes,
        comparison: {
          scopeId: selected.id,
          change:
            decodedDiff.right.status === "binary_or_undecodable"
              ? "opaque"
              : decodedDiff.right.status,
          before: decodedDiff.right.baseline,
          after: decodedDiff.right.current,
        },
        anchors: decodedHunks.right.hunks.map((hunk) => ({
          side: hunk.side === "additions" ? "after" : "before",
          line: hunk.line + 1,
        })),
      },
    })
  );
}
