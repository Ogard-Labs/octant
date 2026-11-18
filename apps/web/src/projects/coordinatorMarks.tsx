import { Network } from "../ui/icons";

/**
 * The coordinator mark and the worker mark, drawn as a pair
 * (docs/design/workspace.md#coordinators): a coordinator wears the network
 * glyph, and each of its workers the same glyph one step smaller and quieter,
 * a child of it. Both stand in place of the thread's provider mark wherever
 * the role matters, and both carry an accessible name.
 */
export function CoordinatorMark(props: { readonly size?: 14 | 16 }) {
  return (
    <Network
      aria-label="Coordinator"
      className="coordinator-mark"
      role="img"
      size={props.size ?? 14}
    />
  );
}

/** A worker's mark. `coordinatorName` names whose worker it is when the list knows. */
export function WorkerMark(props: {
  readonly coordinatorName?: string | undefined;
  readonly size?: 12 | 14;
}) {
  return (
    <Network
      aria-label={
        props.coordinatorName === undefined ? "Worker" : `Worker of ${props.coordinatorName}`
      }
      className="worker-mark"
      role="img"
      size={props.size ?? 12}
    />
  );
}
