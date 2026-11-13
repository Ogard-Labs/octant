/**
 * Publisher key pinning for installed packages. It began with outside
 * provider drivers, whose names it keeps, and now holds for every package
 * kind whose signature the host verifies on the way in.
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

/**
 * Whether an update keeps the trust the package already had. It does when
 * the key pinned for the package signed the updated version: the person
 * trusted that publisher, and the host verified the signature. A new key, a
 * missing signature, or a package with no pin asks again, and so does an
 * update that may do more than the version the person reviewed.
 */
export function outsideDriverUpdateKeepsTrust(input: {
  readonly trusted: boolean;
  readonly pinned: string | undefined;
  readonly updated: string | undefined;
  readonly capabilitiesWidened: boolean;
}): boolean {
  return (
    input.trusted &&
    !input.capabilitiesWidened &&
    input.pinned !== undefined &&
    outsideDriverPublisherStanding(input.pinned, input.updated).kind === "pinned-publisher"
  );
}

/**
 * Whether an update's version must wait for the person's trust because of
 * who signed it. It must when the pinned key did not sign it (another key,
 * or none), and when it is signed and no key is pinned: the first signature
 * to appear on a package the person trusted unsigned is a key nobody has
 * accepted, and it could be anyone's. The update loses its trust and its
 * switch; trusting the source again, with the key shown, pins that key, and
 * from then on the key rule holds. Letting the first signed version run and
 * pinning nothing would leave the package with a key that is never checked.
 */
export function updateAwaitsPublisherTrust(
  pinned: string | undefined,
  updated: string | undefined,
): boolean {
  return pinned === undefined
    ? updated !== undefined
    : outsideDriverPublisherStanding(pinned, updated).kind === "publisher-changed";
}

/** Where the host recorded a package came from, as its manifest states it. */
export interface ExtensionSourceIdentity {
  readonly source:
    | { readonly kind: string; readonly sourceRef: string }
    | { readonly kind: string; readonly catalogId: string; readonly entryId: string };
  /** The registry and package name, for a package the host fetched from npm. */
  readonly npm?: { readonly packageName: string; readonly registry: string } | undefined;
}

/**
 * Whether two versions came from one source: the same folder, the same
 * catalog entry, or the same package of the same npm registry. The version
 * and the tarball's integrity differ between two releases and are not part
 * of where a package comes from.
 */
export function sameExtensionSource(
  previous: ExtensionSourceIdentity,
  next: ExtensionSourceIdentity,
): boolean {
  const a = previous.source;
  const b = next.source;
  if (a.kind !== b.kind) return false;
  const sameReference =
    "sourceRef" in a
      ? "sourceRef" in b && a.sourceRef === b.sourceRef
      : !("sourceRef" in b) && a.catalogId === b.catalogId && a.entryId === b.entryId;
  if (!sameReference) return false;
  if (previous.npm === undefined || next.npm === undefined) return previous.npm === next.npm;
  return (
    previous.npm.packageName === next.npm.packageName && previous.npm.registry === next.npm.registry
  );
}

/**
 * Whether an unsigned package's update keeps the approvals its tools were
 * given (maintainer decision, 2026-11-13). No key vouches for either
 * version, so what the person trusted is the source: an update the host took
 * from that same source keeps them, and the person is shown the update and
 * can roll it back. It asks again when the package was not trusted, when the
 * source differs, when the update may do more than the reviewed version, and
 * wherever a key exists or existed: then the key rule above decides.
 *
 * Accepted risk: whoever controls that source can publish an update that
 * runs under the approvals already given. The notice, the one-click roll
 * back, and the asks that never rest on a grant (Plan, an ask-every-call
 * tool) are what bound it.
 */
export function unsignedUpdateKeepsApprovals(input: {
  readonly trusted: boolean;
  readonly pinned: string | undefined;
  readonly previous: string | undefined;
  readonly updated: string | undefined;
  readonly sameSource: boolean;
  readonly capabilitiesWidened: boolean;
}): boolean {
  return (
    input.trusted &&
    input.sameSource &&
    !input.capabilitiesWidened &&
    input.pinned === undefined &&
    input.previous === undefined &&
    input.updated === undefined
  );
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
