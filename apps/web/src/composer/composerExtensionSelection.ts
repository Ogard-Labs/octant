import type { ExtensionSelection } from "@octant/contracts/extensions";

/** A draft reference and the host's latest resolution receipt for it. */
export interface ComposerExtensionSelection {
  readonly label: string;
  readonly reference: string;
  readonly selection?: ExtensionSelection;
  readonly status:
    | { readonly kind: "selected" }
    | { readonly kind: "blocked"; readonly reason: string };
}
