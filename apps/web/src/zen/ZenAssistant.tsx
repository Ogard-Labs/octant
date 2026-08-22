import type { ZenAssistantSnapshot } from "@octant/contracts/zen";
import type { SettingsDeepLink } from "@octant/contracts";
import { NavigatorPanel } from "../navigator/NavigatorPanel";
import type { NavigatorAssistantController } from "../navigator/useNavigatorAssistant";
import { OctantButton } from "../ui/base/OctantButton";

export interface ZenAssistantProps {
  /** The shared Navigator reader — the same one the profile popover uses. */
  readonly controller: NavigatorAssistantController;
  /** Zen's own facts: tool capability and the inert recipe preview. */
  readonly snapshot: ZenAssistantSnapshot | null;
  readonly busy?: boolean;
  readonly onClose: () => void;
  readonly onOpenSettings: (target: SettingsDeepLink) => void;
  readonly onOpenThreads: () => void;
  readonly onConfirmRecipe?: (action: "save" | "place") => void;
}

/**
 * Zen's front onto Navigator.
 *
 * The conversation, its readiness, and the model it runs on are not Zen's to
 * own: this is a wrapper over the same Navigator panel the profile popover shows,
 * driven by the same controller, so both surfaces are one conversation on the
 * one configured model. What stays here is what is genuinely Zen's — the Zen
 * tool-capability notice and the inert recipe preview, which remain
 * propose-then-confirm and are placed only when the user confirms them.
 */
export function ZenAssistant(props: ZenAssistantProps) {
  const provider = props.snapshot?.provider;
  const toolsAvailable = provider?.toolCapability === "supported";
  const recipePreview = props.snapshot?.recipePreview;

  return (
    <div className="zen-panel card card-tight card-raised zen-assistant" role="dialog">
      <NavigatorPanel
        controller={props.controller}
        onClose={props.onClose}
        onOpenSettings={props.onOpenSettings}
      >
        {toolsAvailable ? (
          <p className="zen-assistant__capability">Typed Zen actions supported</p>
        ) : (
          <div className="zen-assistant__capability" role="status">
            <strong>Assistant actions unavailable</strong>
            <p>
              {provider?.toolCapabilityReason ??
                "Tool capability is unavailable. Use the manual Zen controls."}
            </p>
            <OctantButton onClick={props.onOpenThreads} type="button" variant="secondary">
              Open Threads
            </OctantButton>
          </div>
        )}

        {recipePreview === undefined || recipePreview === null ? null : (
          <section aria-label="Recipe preview" className="zen-assistant__recipe-preview">
            <h3>{recipePreview.recipe.name}</h3>
            <p>Typed recipe preview — nothing has been saved or placed.</p>
            <p>{recipePreview.recipe.primitives.join(" · ")}</p>
            <OctantButton
              disabled={props.onConfirmRecipe === undefined || props.busy}
              onClick={() => props.onConfirmRecipe?.("save")}
              type="button"
              variant="secondary"
            >
              Save recipe
            </OctantButton>
            <OctantButton
              disabled={props.onConfirmRecipe === undefined || props.busy}
              onClick={() => props.onConfirmRecipe?.("place")}
              type="button"
              variant="default"
            >
              Place recipe
            </OctantButton>
          </section>
        )}
      </NavigatorPanel>
    </div>
  );
}
