import type { ProviderInstanceId, ThreadDocumentDelivery } from "@octant/contracts";
import type { PickerGroup } from "@octant/domain";
import { OctantAlert } from "../ui/base/OctantAlert";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantConfirmDialog } from "../ui/base/OctantConfirmDialog";

/** What choosing Claude artifacts for one thread changes, said the same way everywhere. */
export const THREAD_ARTIFACTS_WARNING =
  "Claude artifacts turn on Claude Code’s usage telemetry to Anthropic for this thread’s turns. Error reports and conversation uploads stay off.";

/**
 * Whether a thread on this provider account may choose the runtime's own
 * artifact tool: the account enabled it and nothing on the host keeps it off,
 * as the provider's last report says.
 */
export function threadMayChooseArtifacts(
  groups: ReadonlyArray<PickerGroup>,
  providerInstanceId: ProviderInstanceId,
  mode: "work" | "code",
): boolean {
  const group = groups.find(
    (candidate) => String(candidate.instance.id) === String(providerInstanceId),
  );
  return group?.nativeArtifacts?.[mode] === "supported";
}

/**
 * Where the one-time offer goes, if anywhere: beneath the thread's first
 * Canvas, while a thread that may use Claude artifacts has not chosen either
 * way. Either answer is journaled on the thread, so it never returns.
 */
export function threadArtifactsOfferRow(input: {
  readonly choosable: boolean;
  readonly documentDelivery: ThreadDocumentDelivery | undefined;
  readonly rowKeys: ReadonlyArray<string>;
  readonly canvasesByRow: ReadonlyMap<string, ReadonlyArray<unknown>>;
}): string | undefined {
  if (!input.choosable || input.documentDelivery !== undefined) return undefined;
  return input.rowKeys.find((key) => (input.canvasesByRow.get(key)?.length ?? 0) > 0);
}

/**
 * The one-time offer beneath a thread's first Canvas. Either answer is the
 * thread's journaled choice, so the offer never returns once answered; the
 * thread's actions menu switches it either way afterwards.
 */
export function ThreadArtifactsOffer(props: {
  readonly pending: boolean;
  readonly onChoose: (choice: ThreadDocumentDelivery) => void;
}) {
  return (
    <OctantAlert
      action={
        <>
          <OctantButton
            disabled={props.pending}
            onClick={() => props.onChoose("canvas")}
            size="sm"
            type="button"
            variant="outline"
          >
            Keep Canvas
          </OctantButton>
          <OctantButton
            disabled={props.pending}
            onClick={() => props.onChoose("native-artifacts")}
            size="sm"
            type="button"
            variant="secondary"
          >
            Use Claude artifacts
          </OctantButton>
        </>
      }
      className="thread-artifacts-offer"
      role="status"
      title="Use Claude artifacts for this thread instead?"
      tone="neutral"
    >
      <p>
        Claude would publish this thread’s documents to your claude.ai account instead of making a
        Canvas, from the next turn. {THREAD_ARTIFACTS_WARNING}
      </p>
    </OctantAlert>
  );
}

/** The confirmation behind the thread menu's "Use Claude artifacts". */
export function ThreadArtifactsConfirm(props: {
  readonly pending: boolean;
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
}) {
  return (
    <OctantConfirmDialog
      confirmLabel="Use Claude artifacts"
      onCancel={props.onCancel}
      onConfirm={props.onConfirm}
      pending={props.pending}
      title="Use Claude artifacts for this thread?"
    >
      From the next turn, Claude publishes this thread’s documents to your claude.ai account instead
      of making a Canvas. {THREAD_ARTIFACTS_WARNING}
    </OctantConfirmDialog>
  );
}
