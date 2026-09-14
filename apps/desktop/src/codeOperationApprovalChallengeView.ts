export interface ApprovalChallengeView {
  readonly challengeId: string;
  readonly effectDigest: string;
  readonly contextDigest: string;
  readonly projectId: string;
  readonly threadId: string;
  readonly checkoutId: string;
  readonly repositoryId: string;
  readonly checkoutHead:
    | { readonly kind: "branch"; readonly name: string; readonly oid: string }
    | { readonly kind: "detached"; readonly oid: string }
    | { readonly kind: "none" };
  readonly pullRequestTarget?: {
    readonly baseRepository: string;
    readonly baseBranch: string;
    readonly head: string;
  };
  readonly message: string;
  readonly detail: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function decodeChallenge(value: unknown): ApprovalChallengeView | undefined {
  if (!isRecord(value)) return undefined;
  const challengeId = stringField(value, "challengeId");
  const effectDigest = stringField(value, "effectDigest");
  const contextDigest = stringField(value, "contextDigest");
  const projectId = stringField(value, "projectId");
  const threadId = stringField(value, "threadId");
  const checkoutId = stringField(value, "checkoutId");
  const repositoryId = stringField(value, "repositoryId");
  const message = stringField(value, "message");
  const detail = stringField(value, "detail");
  const checkoutHeadValue = value.checkoutHead;
  if (
    challengeId === undefined ||
    effectDigest === undefined ||
    contextDigest === undefined ||
    projectId === undefined ||
    threadId === undefined ||
    checkoutId === undefined ||
    repositoryId === undefined ||
    message === undefined ||
    detail === undefined ||
    !isRecord(checkoutHeadValue)
  ) {
    return undefined;
  }
  const oid = stringField(checkoutHeadValue, "oid");
  if (oid === undefined && checkoutHeadValue.kind !== "none") return undefined;
  const checkoutHead =
    checkoutHeadValue.kind === "branch" && oid !== undefined
      ? (() => {
          const name = stringField(checkoutHeadValue, "name");
          return name === undefined ? undefined : { kind: "branch" as const, name, oid };
        })()
      : checkoutHeadValue.kind === "detached" && oid !== undefined
        ? { kind: "detached" as const, oid }
        : checkoutHeadValue.kind === "none"
          ? { kind: "none" as const }
          : undefined;
  if (checkoutHead === undefined) return undefined;

  const pullRequestValue = value.pullRequestTarget;
  let pullRequestTarget: ApprovalChallengeView["pullRequestTarget"];
  if (pullRequestValue === undefined) {
    pullRequestTarget = undefined;
  } else {
    if (!isRecord(pullRequestValue)) return undefined;
    const baseRepository = stringField(pullRequestValue, "baseRepository");
    const baseBranch = stringField(pullRequestValue, "baseBranch");
    const head = stringField(pullRequestValue, "head");
    if (baseRepository === undefined || baseBranch === undefined || head === undefined) {
      return undefined;
    }
    pullRequestTarget = { baseRepository, baseBranch, head };
  }

  return {
    challengeId,
    effectDigest,
    contextDigest,
    projectId,
    threadId,
    checkoutId,
    repositoryId,
    checkoutHead,
    ...(pullRequestTarget === undefined ? {} : { pullRequestTarget }),
    message,
    detail,
  };
}
