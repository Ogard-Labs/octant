/**
 * Publisher key pinning for outside provider drivers.
 *
 * A package name from one source keeps the publisher key it was first
 * trusted under. The pin outlives an uninstall, so reinstalling the same
 * name from the same source is held when another key signed it; only the
 * person, at a local window, re-trusts a new publisher or forgets the pin.
 * Keys are compared by their fingerprints, which the host computes from the
 * signature it verified.
 */

/** Where a selected version stands against the pin for its package name and source. */
export type OutsideDriverPublisherStanding =
  /** No key is pinned: trusting a signed version pins its key, an unsigned one pins nothing. */
  | { readonly kind: "unpinned" }
  /** The pinned key signed the selected version. */
  | { readonly kind: "pinned-publisher" }
  /**
   * The selected version is signed by another key, or by none. It is held
   * until the person re-trusts the new publisher or forgets the pin; trust
   * alone does not lift it.
   */
  | { readonly kind: "publisher-changed" };

export function outsideDriverPublisherStanding(
  pinned: string | undefined,
  selected: string | undefined,
): OutsideDriverPublisherStanding {
  if (pinned === undefined) return { kind: "unpinned" };
  return pinned === selected ? { kind: "pinned-publisher" } : { kind: "publisher-changed" };
}

/**
 * The key a trust pins: the selected version's key, when it is signed and
 * nothing is pinned yet. A pin is never replaced by trusting; that is the
 * new-publisher action's alone.
 */
export function outsideDriverPublisherPinAtTrust<Key extends string>(
  pinned: Key | undefined,
  selected: Key | undefined,
): Key | undefined {
  return pinned === undefined ? selected : undefined;
}

export type OutsideDriverNewPublisherDecision<Key extends string = string> =
  | { readonly kind: "replace"; readonly previous: Key; readonly next: Key }
  | {
      readonly kind: "refused";
      /**
       * `not-held`: the selected version is not held for its publisher.
       * `unsigned`: no key signed the selected version, so there is no
       *   publisher to trust; forgetting the pin is the person's way on.
       * `key-mismatch`: the key the person saw is not the one that signed it.
       */
      readonly reason: "not-held" | "unsigned" | "key-mismatch";
    };

/**
 * Re-trusting a new publisher replaces the pin with the key that signed the
 * selected version, and only when the person confirms that exact key.
 */
export function decideOutsideDriverNewPublisher<Key extends string>(input: {
  readonly pinned: Key | undefined;
  readonly selected: Key | undefined;
  readonly confirmed: Key;
}): OutsideDriverNewPublisherDecision<Key> {
  if (input.pinned === undefined) return { kind: "refused", reason: "not-held" };
  if (outsideDriverPublisherStanding(input.pinned, input.selected).kind !== "publisher-changed") {
    return { kind: "refused", reason: "not-held" };
  }
  if (input.selected === undefined) return { kind: "refused", reason: "unsigned" };
  if (input.selected !== input.confirmed) return { kind: "refused", reason: "key-mismatch" };
  return { kind: "replace", previous: input.pinned, next: input.selected };
}
