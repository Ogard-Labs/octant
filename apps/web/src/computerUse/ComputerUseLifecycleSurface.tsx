import type { ComputerUseClient } from "@octant/client-runtime/computer-use-client";
import type { ComputerUseSessionScope } from "@octant/contracts/computer-use";
import { OctantButton } from "../ui/base/OctantButton";
import { ComputerUseLifecyclePane } from "./ComputerUseLifecyclePane";
import { useComputerUseLifecycle } from "./useComputerUseLifecycle";

export function ComputerUseLifecycleSurface(props: {
  readonly client: ComputerUseClient;
  readonly scope: ComputerUseSessionScope;
}) {
  const controller = useComputerUseLifecycle(props);
  if (controller.status === "loading") {
    return (
      <section aria-label="Computer use">
        <p role="status">Loading computer use…</p>
      </section>
    );
  }
  if (controller.status !== "ready" || controller.view === undefined) {
    return (
      <section aria-label="Computer use">
        <div role="alert">
          <strong>
            {controller.status === "interrupted"
              ? "Computer use interrupted"
              : controller.status === "failed"
                ? "Computer use failed"
                : "Computer use unavailable"}
          </strong>
          <p>{controller.errorMessage ?? "The authoritative host lifecycle is unavailable."}</p>
        </div>
        <OctantButton onClick={controller.retry} type="button" variant="secondary">
          Retry
        </OctantButton>
      </section>
    );
  }
  return (
    <ComputerUseLifecyclePane
      busy={controller.busy}
      onApprove={() => void controller.approve()}
      onDeny={() => void controller.deny()}
      onStop={() => void controller.stop()}
      view={controller.view}
    />
  );
}
