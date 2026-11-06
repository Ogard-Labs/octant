import { OctantBadge } from "../ui/base/OctantBadge";

/** A local application label; it describes no host, window or capability authority. */
export function ApplicationIdentity(props: {
  readonly productName: "Octant Nightly";
  /** Nightly runs its own host on separate test data, never a person's real work. */
  readonly testData?: boolean;
}) {
  return (
    <span
      aria-label={props.testData === true ? `${props.productName}, test data` : props.productName}
      className="application-identity"
      role="group"
    >
      <span>{props.productName.slice(0, -" Nightly".length)}</span>
      <OctantBadge variant="secondary">Nightly</OctantBadge>
      {props.testData === true ? <OctantBadge variant="outline">Test data</OctantBadge> : null}
    </span>
  );
}
