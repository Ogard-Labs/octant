// Pure rules of push through the hub: which gateway a forward may reach, and
// how often one spoke may ask. The hub forwards a request someone else signed,
// so these two rules are the whole of what it decides itself.

export type PushGatewayDecision =
  | { readonly status: "forward"; readonly gatewayUrl: string }
  | { readonly status: "refuse"; readonly kind: "gateway-mismatch" };

function sameGateway(left: string, right: string): boolean {
  try {
    const a = new URL(left);
    const b = new URL(right);
    return (
      a.origin === b.origin && a.pathname.replace(/\/+$/, "") === b.pathname.replace(/\/+$/, "")
    );
  } catch {
    return false;
  }
}

/**
 * A request that names no gateway goes to the one the hub's person configured.
 * A request that names one goes there only if it is that same gateway: a spoke
 * cannot make the hub send a signed request to an address its person never
 * chose.
 */
export function decidePushGateway(input: {
  readonly requested: string | undefined;
  readonly configured: string;
}): PushGatewayDecision {
  if (input.requested === undefined || sameGateway(input.requested, input.configured)) {
    return { status: "forward", gatewayUrl: input.configured };
  }
  return { status: "refuse", kind: "gateway-mismatch" };
}

export type PushRateDecision =
  | { readonly status: "allow"; readonly recent: ReadonlyArray<number> }
  | { readonly status: "refuse"; readonly kind: "rate-limited" };

/**
 * At most `max` requests from one spoke in any `windowMs`. `recent` holds the
 * times of that spoke's earlier requests; the answer carries the list to keep.
 */
export function decidePushRate(input: {
  readonly recent: ReadonlyArray<number>;
  readonly nowMs: number;
  readonly windowMs: number;
  readonly max: number;
}): PushRateDecision {
  const kept = input.recent.filter((at) => at > input.nowMs - input.windowMs);
  if (kept.length >= input.max) return { status: "refuse", kind: "rate-limited" };
  return { status: "allow", recent: [...kept, input.nowMs] };
}
