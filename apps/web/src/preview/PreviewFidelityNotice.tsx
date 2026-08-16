import type { PreviewFidelity } from "@octant/contracts/previews";

/**
 * Render the manifest's fidelity notice when the preview is limited. The
 * notice is always visible for limited-fidelity formats so the viewer
 * never presents an incomplete render as pixel-perfect success. Full
 * fidelity renders nothing.
 */
export function PreviewFidelityNotice(props: { readonly fidelity: PreviewFidelity }) {
  if (props.fidelity.level === "full") return null;
  return (
    <div className="preview-fidelity-notice" role="status">
      <span className="preview-fidelity-notice__icon" aria-hidden="true">
        !
      </span>
      <p className="preview-fidelity-notice__text">
        {props.fidelity.notice ?? "Limited-fidelity preview; some content may be omitted."}
      </p>
    </div>
  );
}
