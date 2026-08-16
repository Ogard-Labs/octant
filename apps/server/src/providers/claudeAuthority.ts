import { createHash } from "node:crypto";

const AUTHORITY_INPUT_MAX_CHARACTERS = 1_048_576;
const AUTHORITY_CONTAINER_MAX_ENTRIES = 4_096;
const AUTHORITY_INPUT_MAX_NODES = 16_384;
const AUTHORITY_INPUT_MAX_DEPTH = 16;

interface AuthorityInputBudget {
  remaining: number;
  nodes: number;
}

function consume(budget: AuthorityInputBudget, characters: number): boolean {
  if (!Number.isSafeInteger(characters) || characters < 0 || characters > budget.remaining) {
    return false;
  }
  budget.remaining -= characters;
  return true;
}

function encodedString(value: string, budget: AuthorityInputBudget): string | undefined {
  // JSON escaping may expand one UTF-16 code unit to six characters. Reject before allocating
  // when even that safe upper bound cannot fit the remaining cumulative budget.
  if (value.length > Math.floor(budget.remaining / 6)) return undefined;
  const encoded = JSON.stringify(value);
  return consume(budget, encoded.length) ? encoded : undefined;
}

function canonicalInput(
  value: unknown,
  seen: Set<object>,
  budget: AuthorityInputBudget,
  depth = 0,
): string | undefined {
  budget.nodes += 1;
  if (depth > AUTHORITY_INPUT_MAX_DEPTH || budget.nodes > AUTHORITY_INPUT_MAX_NODES) {
    return undefined;
  }
  if (value === null || typeof value === "boolean") {
    const encoded = JSON.stringify(value);
    return consume(budget, encoded.length) ? encoded : undefined;
  }
  if (typeof value === "string") return encodedString(value, budget);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return undefined;
    const encoded = JSON.stringify(value);
    return consume(budget, encoded.length) ? encoded : undefined;
  }
  if (typeof value !== "object" || seen.has(value)) return undefined;
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      if (value.length > AUTHORITY_CONTAINER_MAX_ENTRIES || !consume(budget, 2)) {
        return undefined;
      }
      const items: string[] = [];
      for (let index = 0; index < value.length; index += 1) {
        if (index > 0 && !consume(budget, 1)) return undefined;
        const item = canonicalInput(value[index], seen, budget, depth + 1);
        if (item === undefined) return undefined;
        items.push(item);
      }
      return `[${items.join(",")}]`;
    }

    const keys: string[] = [];
    for (const key in value) {
      if (!Object.hasOwn(value, key)) continue;
      keys.push(key);
      if (keys.length > AUTHORITY_CONTAINER_MAX_ENTRIES) return undefined;
    }
    keys.sort();
    if (!consume(budget, 2)) return undefined;
    const entries: string[] = [];
    for (const key of keys) {
      if (entries.length > 0 && !consume(budget, 1)) return undefined;
      const encodedKey = encodedString(key, budget);
      if (encodedKey === undefined || !consume(budget, 1)) return undefined;
      const item = canonicalInput(
        (value as Readonly<Record<string, unknown>>)[key],
        seen,
        budget,
        depth + 1,
      );
      if (item === undefined) return undefined;
      entries.push(`${encodedKey}:${item}`);
    }
    return `{${entries.join(",")}}`;
  } finally {
    seen.delete(value);
  }
}

export function claudeAuthorityInputDigest(input: unknown): string | undefined {
  try {
    const canonical = canonicalInput(input, new Set(), {
      remaining: AUTHORITY_INPUT_MAX_CHARACTERS,
      nodes: 0,
    });
    return canonical === undefined
      ? undefined
      : createHash("sha256").update(canonical).digest("hex");
  } catch {
    return undefined;
  }
}

export function waitForClaudeAuthorityValue<A>(input: {
  readonly promise: Promise<A>;
  readonly signal: AbortSignal;
  readonly cancel: () => void;
  readonly cancelledValue: A;
}): Promise<A> {
  if (input.signal.aborted) {
    input.cancel();
    return Promise.resolve(input.cancelledValue);
  }
  return new Promise((resolveValue) => {
    let settled = false;
    const finish = (value: A) => {
      if (settled) return;
      settled = true;
      input.signal.removeEventListener("abort", onAbort);
      resolveValue(value);
    };
    const onAbort = () => {
      input.cancel();
      finish(input.cancelledValue);
    };
    input.signal.addEventListener("abort", onAbort, { once: true });
    void input.promise.then(finish, () => finish(input.cancelledValue));
  });
}
