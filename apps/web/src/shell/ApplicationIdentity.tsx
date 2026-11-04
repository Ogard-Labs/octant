import { OctantBadge } from "../ui/base/OctantBadge";

/** A local application label; it describes no host, window or capability authority. */
export function ApplicationIdentity(props: { readonly productName: "Octant Nightly" }) {
  return (
    <span aria-label={props.productName} className="application-identity" role="group">
      <span>{props.productName.slice(0, -" Nightly".length)}</span>
      <OctantBadge variant="secondary">Nightly</OctantBadge>
    </span>
  );
}
