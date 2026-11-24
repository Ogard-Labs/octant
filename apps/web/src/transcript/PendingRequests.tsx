import type { ReactNode } from "react";
import "./pending-requests.css";

/**
 * The provider's pending questions and approvals, docked at the foot of the
 * thread just above the composer in Chat, Work and Code. They are actionable
 * composer state: kept here, the answer is never separated from the message
 * field by a long transcript, and the reply that asked still says it waits.
 */
export function PendingRequests(props: { readonly children: ReactNode }) {
  return (
    <div aria-label="Pending provider requests" className="thread-pending-requests thread-column">
      {props.children}
    </div>
  );
}
