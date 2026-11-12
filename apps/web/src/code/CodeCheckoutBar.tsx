import { FolderOpen, GitBranch, GitPullRequest, Network } from "lucide-react";
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
export function CodeCheckoutBar(props: {
  readonly onCreatePullRequest?: () => void;
  /**
   * `alias:folder` of a thread in a server Project. This host reads no branch
   * or diff of it, so the bar names where it runs instead.
   */
  readonly serverLocation?: string;
  /** Opens the Git tab, whose Git runs on the server. */
  readonly onOpenServerGit?: () => void;
  /** Opens Review on the checkout's changes. */
  readonly onOpenReview?: () => void;
}) {
  const checkout = useCodeCheckout();
  if (props.serverLocation !== undefined) {
    return (
      <div aria-label="Checkout" className="code-checkout-bar">
        <span className="code-checkout-bar__identity">
          <span className="composer-place__icon">
            <Network aria-hidden="true" size={16} />
          </span>
          <span
            className="code-checkout-bar__project"
            title={`On a server: ${props.serverLocation}`}
          >
            {props.serverLocation}
          </span>
        </span>
        {props.onOpenServerGit === undefined ? null : (
          <OctantButton
            className="code-checkout-bar__action window-no-drag"
            onClick={props.onOpenServerGit}
            size="sm"
            title="Git on the server"
            type="button"
            variant="ghost"
          >
            <GitBranch aria-hidden="true" size={14} />
            <span>Git</span>
          </OctantButton>
        )}
        {props.onCreatePullRequest === undefined ? null : (
          <CreatePullRequestAction onCreatePullRequest={props.onCreatePullRequest} />
        )}
      </div>
    );
  }
  // The attached strip is part of the composer even while its metadata is
  // unavailable; returning null collapses its border and shifts the controls.
  if (checkout === undefined) return <div aria-label="Checkout" className="code-checkout-bar" />;
  const repositoryName =
    checkout.repositoryRoot
      .replace(/[\\/]+$/, "")
      .split(/[\\/]/)
      .at(-1) || checkout.repositoryRoot;
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
      {checkout.workingFolderUnavailable === true ? (
        <span className="code-checkout-bar__working-folder" role="status">
          Working folder unavailable
        </span>
      ) : checkout.workingFolder === undefined ? null : (
        <span
          className="code-checkout-bar__working-folder"
          title={
            checkout.workingFolder.kind === "extra"
              ? "Shared folder outside the worktree. Git, Review and changed files cover the checkout only."
              : "Task working folder"
          }
        >
          Working: {checkout.workingFolder.label}
          {String(checkout.workingDirectory ?? ".") === "."
            ? ""
            : ` / ${checkout.workingDirectory}`}
          {checkout.workingFolder.kind === "extra" ? " (shared; Review is checkout only)" : ""}
        </span>
      )}
      <span className="code-checkout-bar__identity">
        <span className="composer-place__icon">
          <FolderOpen aria-hidden="true" size={16} />
        </span>
        <span
          className="code-checkout-bar__project"
          title={`${checkout.projectName} · ${checkout.repositoryRoot}`}
        >
          {repositoryName}
        </span>
        <GitBranch aria-hidden="true" size={12} />
        <span className="code-checkout-bar__branch" title={branch}>
          {branch}
        </span>
      </span>
      {measured ? (
        props.onOpenReview === undefined ? (
          <span className="code-checkout-bar__diffstat">
            <span className="code-checkout-bar__insertions">{`+${insertions.toLocaleString("en")}`}</span>
            <span className="code-checkout-bar__deletions">{`−${deletions.toLocaleString("en")}`}</span>
          </span>
        ) : (
          // The size of the diff is the way into it. As plain text it named
          // the changes and left the person to find the Review tool in the dock.
          <OctantButton
            aria-label={`Review changes: ${insertions.toLocaleString("en")} added, ${deletions.toLocaleString("en")} removed`}
            // Not the strip's action class: at phone width that one hides a
            // button's words to leave its icon, and this button is its words.
            className="code-checkout-bar__review window-no-drag"
            onClick={props.onOpenReview}
            size="sm"
            title="Review changes"
            type="button"
            variant="ghost"
          >
            <span className="code-checkout-bar__diffstat">
              <span className="code-checkout-bar__insertions">{`+${insertions.toLocaleString("en")}`}</span>
              <span className="code-checkout-bar__deletions">{`−${deletions.toLocaleString("en")}`}</span>
            </span>
          </OctantButton>
        )
      ) : null}
      {props.onCreatePullRequest === undefined ? null : (
        <CreatePullRequestAction onCreatePullRequest={props.onCreatePullRequest} />
      )}
    </div>
  );
}

function CreatePullRequestAction(props: { readonly onCreatePullRequest: () => void }) {
  return (
    <OctantButton
      aria-label="Create pull request"
      title="Create pull request"
      className="code-checkout-bar__action window-no-drag"
      onClick={props.onCreatePullRequest}
      size="sm"
      type="button"
      variant="ghost"
    >
      <GitPullRequest aria-hidden="true" size={14} />
      <span>Create pull request</span>
    </OctantButton>
  );
}
