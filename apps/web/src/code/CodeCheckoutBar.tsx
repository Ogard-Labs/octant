import { GitBranch, GitPullRequest } from "lucide-react";
import { useCodeCheckout } from "../environment/CodeCheckoutContext";
import { OctantButton } from "../ui/base/OctantButton";

/**
 * What the next message will be typed against: the checkout, and what it has
 * changed.
 *
 * The composer is where a thread's work is directed, and the branch and the
 * size of the diff were only visible in a panel the reader had to open. Stating
 * them here also gives the one action those facts lead to — raising a pull
 * request — a place to sit next to the evidence for it.
 */
export function CodeCheckoutBar(props: { readonly onCreatePullRequest?: () => void }) {
  const checkout = useCodeCheckout();
  if (checkout === undefined) return null;
  const branch =
    checkout.branch.kind === "named"
      ? checkout.branch.name
      : `Detached ${checkout.branch.oid.slice(0, 7)}`;
  const insertions = checkout.insertions;
  const deletions = checkout.deletions;
  const measured =
    checkout.changes === "dirty" && insertions !== undefined && deletions !== undefined;

  return (
    <div aria-label="Checkout" className="code-checkout-bar">
      <span className="code-checkout-bar__identity">
        <span className="code-checkout-bar__project">{checkout.projectName}</span>
        <GitBranch aria-hidden="true" size={12} strokeWidth={1.8} />
        <span className="code-checkout-bar__branch" title={branch}>
          {branch}
        </span>
      </span>
      {measured ? (
        <span className="code-checkout-bar__diffstat">
          <span className="code-checkout-bar__insertions">{`+${insertions.toLocaleString()}`}</span>
          <span className="code-checkout-bar__deletions">{`−${deletions.toLocaleString()}`}</span>
        </span>
      ) : null}
      {props.onCreatePullRequest === undefined ? null : (
        <OctantButton
          className="code-checkout-bar__action window-no-drag"
          onClick={props.onCreatePullRequest}
          size="sm"
          type="button"
          variant="ghost"
        >
          <GitPullRequest aria-hidden="true" size={14} strokeWidth={1.7} />
          <span>Create PR</span>
        </OctantButton>
      )}
    </div>
  );
}
