import type { ShipClient } from "@octant/client-runtime/ship-client";
import type { ShipPlan, ShipTarget } from "@octant/contracts";
import { useCallback, useEffect, useState } from "react";
import { OctantButton } from "../ui/base/OctantButton";

export interface ShipPanelProps {
  readonly client?: ShipClient;
  readonly threadId: string;
}

export function deliveryToolIsPresent(
  targets: ReadonlyArray<ShipTarget>,
  plan?: ShipPlan,
): boolean {
  return plan !== undefined || targets.some((target) => target.enabled);
}

/**
 * Delivering this work to somewhere you own.
 *
 * The wording is deliberate about what Octant is not doing. There is no target
 * of its own to fall back to and nothing of yours routed through it: a target
 * is a remote you already have, and what travels is the reviewed revision.
 *
 * Nothing here decides anything. The host states what it is about to publish,
 * the person approves that exact act, and a refusal is shown in the host's own
 * words rather than re-derived here.
 */
export function ShipPanel(props: ShipPanelProps) {
  const { client, threadId } = props;
  const [targets, setTargets] = useState<ReadonlyArray<ShipTarget>>([]);
  const [plan, setPlan] = useState<ShipPlan | undefined>(undefined);
  const [notice, setNotice] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);

  const reload = useCallback(async () => {
    if (client === undefined) return;
    try {
      setTargets(await client.targets());
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Ship targets are unavailable.");
    }
  }, [client]);

  useEffect(() => {
    void reload();
  }, [reload]);

  if (client === undefined) return null;

  const enabled = targets.filter((target) => target.enabled);
  if (!deliveryToolIsPresent(targets, plan) && notice === undefined) return null;

  const run = async (command: Parameters<ShipClient["execute"]>[0]) => {
    setBusy(true);
    try {
      const result = await client.execute(command);
      if (result.kind === "ship-refused") {
        setPlan(undefined);
        setNotice(result.message);
        return;
      }
      if (result.kind === "ship-plan") {
        setPlan(result.plan);
        setNotice(undefined);
        return;
      }
      if (result.kind === "ship-receipt") {
        setPlan(undefined);
        setNotice(
          result.receipt.outcome === "published"
            ? "Delivered."
            : (result.receipt.detail ?? "That delivery did not happen."),
        );
        return;
      }
      setTargets(result.targets);
      setNotice(undefined);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "The ship command failed.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section aria-label="Delivery" className="ship-panel">
      <p className="ship-panel__note">
        Octant delivers to a target you already own and runs none of its own. Nothing is routed
        through Octant, and each delivery is approved on its own.
      </p>

      {enabled.length === 0 ? null : (
        <ul className="ship-panel__targets">
          {enabled.map((target) => (
            <li className="ship-panel__target" key={String(target.id)}>
              <span className="ship-panel__target-name">{target.displayName}</span>
              <span className="ship-panel__target-where">
                {`${target.destination.remoteName}/${target.destination.branch}`}
              </span>
              <span className="ship-panel__target-state">
                Enabled
                {target.credentialReference === undefined
                  ? " · No credential"
                  : " · Credential bound"}
              </span>
              <OctantButton
                disabled={busy}
                onClick={() =>
                  void run({ kind: "plan-ship", targetId: target.id, threadId: threadId as never })
                }
                type="button"
                variant="secondary"
              >
                Review delivery
              </OctantButton>
            </li>
          ))}
        </ul>
      )}

      {plan === undefined ? null : (
        <div className="ship-panel__plan">
          <p className="ship-panel__plan-line">
            {`Deliver ${plan.revision.slice(0, 12)} to ${plan.destination.remoteName}/${plan.destination.branch}`}
          </p>
          <p className="ship-panel__plan-line ship-panel__plan-digest">{plan.artifactDigest}</p>
          <p className="ship-panel__note">
            This makes the change visible to people outside this machine, and no checkpoint here
            undoes that.
          </p>
          <OctantButton
            disabled={busy}
            onClick={() =>
              void run({
                kind: "ship",
                targetId: plan.targetId,
                threadId: threadId as never,
                approvalId: crypto.randomUUID(),
                revision: plan.revision,
                artifactDigest: plan.artifactDigest,
              })
            }
            type="button"
            variant="default"
          >
            Approve delivery
          </OctantButton>
        </div>
      )}

      {notice === undefined ? null : (
        <p className="ship-panel__notice" role="status">
          {notice}
        </p>
      )}
    </section>
  );
}
