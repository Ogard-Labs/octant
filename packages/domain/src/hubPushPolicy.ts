// Pure rules of push through the hub: how often one spoke may ask the hub to
// send a notification on its behalf.

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
