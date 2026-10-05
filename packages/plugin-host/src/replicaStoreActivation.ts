/**
 * Whether a replica store may be offered or called.
 *
 * Installation and enablement are preconditions. A store that is not
 * installed, or that is installed but disabled, is withheld. The decision
 * does not call the store: a withheld store is never offered, and the call
 * the host would have made does not run.
 */

export interface ReplicaStoreActivationFacts {
  readonly installed: boolean;
  readonly enabled: boolean;
}

export type ReplicaStoreWithheld = {
  readonly status: "withheld";
  readonly reason: "not-installed" | "disabled";
};

export type ReplicaStoreOffer = { readonly status: "offered" } | ReplicaStoreWithheld;

export function offerReplicaStore(facts: ReplicaStoreActivationFacts): ReplicaStoreOffer {
  if (!facts.installed) return { status: "withheld", reason: "not-installed" };
  if (!facts.enabled) return { status: "withheld", reason: "disabled" };
  return { status: "offered" };
}

/**
 * Run `call` only when the store is offered.
 *
 * A disabled or uninstalled store returns the withheld decision and does not
 * invoke `call`. Callers that hold a store reference still have to pass
 * through here before using it, so disablement cannot be skipped by keeping
 * the reference.
 */
export function callOfferedReplicaStore<T>(
  facts: ReplicaStoreActivationFacts,
  call: () => T,
): T | ReplicaStoreWithheld {
  const offer = offerReplicaStore(facts);
  if (offer.status === "withheld") return offer;
  return call();
}
