import { useState } from "react";
import type { NativeHarnessApproval } from "@octant/contracts";
import { ApprovalOutsideContentNote } from "../composer/ApprovalOutsideContentNote";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantCheckbox } from "../ui/base/OctantCheckbox";
import "./native-harness.css";

export interface HarnessApprovalPanelProps {
  readonly approval: NativeHarnessApproval;
  readonly busy: boolean;
  /**
   * The person's choice. `commandHosts` is the listed hosts they ticked for
   * this one command; it is absent when the approval listed none. The host
   * checks the answer against what it listed before anything is decided.
   */
  readonly onDecide: (
    decision: "approve" | "approve-always" | "deny",
    commandHosts: ReadonlyArray<{ readonly host: string; readonly port: number }> | undefined,
  ) => void;
}

const hostKey = (host: { readonly host: string; readonly port: number }) =>
  `${host.host}:${String(host.port)}`;

/**
 * One harness approval waiting on a person: what the agent wants to do, why it
 * asks, the hosts a marked thread's command may reach, and the choices. It
 * decides nothing itself; the thread's session route does, after checking who
 * asks, so the same card serves the Agents tab and the thread's own composer.
 */
export function HarnessApprovalPanel(props: HarnessApprovalPanelProps) {
  const { approval, busy } = props;
  // The hosts ticked on a marked thread's command, starting from what the
  // host preselected; reset whenever a different approval is pending.
  const [tickedHosts, setTickedHosts] = useState<{
    readonly approvalId: string;
    readonly keys: ReadonlySet<string>;
  }>();
  const ticked =
    tickedHosts !== undefined && tickedHosts.approvalId === String(approval.id)
      ? tickedHosts.keys
      : new Set((approval.commandHosts ?? []).filter((entry) => entry.preselected).map(hostKey));
  const toggleHost = (key: string, on: boolean) => {
    const keys = new Set(ticked);
    if (on) keys.add(key);
    else keys.delete(key);
    setTickedHosts({ approvalId: String(approval.id), keys });
  };
  const listed = approval.commandHosts;

  return (
    <section aria-label="Approval requested" className="native-harness-question">
      {approval.source === undefined ? null : (
        <p className="native-harness-card__detail" title={String(approval.source.runId)}>
          Child {String(approval.source.runId).slice(0, 8)} ·{" "}
          {approval.source.providerName ?? "Provider"} · {approval.source.modelId}
        </p>
      )}
      <p className="native-harness-question__prompt">
        <strong>
          {approval.toolName === "provider-action" ? "Provider action" : approval.toolName}
        </strong>{" "}
        {approval.summary.replace(/^[a-z-]+: /, "")}
      </p>
      <p className="native-harness-card__detail">
        {approval.source === undefined
          ? `Needs your say-so (${approval.approvalClass}).`
          : "Allow this request for this child."}
      </p>
      {approval.outsideContent === undefined ? null : (
        <ApprovalOutsideContentNote outsideContent={approval.outsideContent} />
      )}
      {approval.detail === undefined ? null : (
        <pre className="native-harness-question__detail">{approval.detail}</pre>
      )}
      {listed === undefined ? null : (
        <>
          <p className="native-harness-card__detail">
            {listed.length === 0
              ? "This command can reach no host: this thread and its Project allow none."
              : "This command can reach only the hosts you tick, and only while it runs."}
          </p>
          {listed.length === 0 ? null : (
            <ul aria-label="Hosts this command may reach" className="native-harness-egress__rules">
              {listed.map((entry) => {
                const key = hostKey(entry);
                return (
                  <li className="native-harness-egress__rule" key={key}>
                    <label className="native-harness-command-host">
                      <OctantCheckbox
                        checked={ticked.has(key)}
                        disabled={busy}
                        onChange={(event) => toggleHost(key, event.target.checked)}
                      />
                      <span className="native-harness-egress__label">
                        <span className="native-harness-egress__host">
                          {entry.port === 443 ? entry.host : key}
                        </span>
                        <span className="native-harness-egress__meta">
                          {entry.from === "thread-rule"
                            ? "Allowed on this thread"
                            : entry.from === "project-rule"
                              ? "Allowed in this Project"
                              : "Refused earlier"}
                        </span>
                      </span>
                    </label>
                  </li>
                );
              })}
            </ul>
          )}
        </>
      )}
      <div className="native-harness-chips">
        <OctantButton
          disabled={busy}
          onClick={() =>
            props.onDecide(
              "approve",
              listed === undefined
                ? undefined
                : listed
                    .filter((entry) => ticked.has(hostKey(entry)))
                    .map((entry) => ({ host: entry.host, port: entry.port })),
            )
          }
          size="sm"
          type="button"
          variant="default"
        >
          Allow
        </OctantButton>
        {approval.source === undefined && approval.singleUse !== true ? (
          <OctantButton
            disabled={busy}
            onClick={() => props.onDecide("approve-always", undefined)}
            size="sm"
            type="button"
            variant="secondary"
          >
            Allow for this session
          </OctantButton>
        ) : null}
        <OctantButton
          disabled={busy}
          onClick={() => props.onDecide("deny", undefined)}
          size="sm"
          type="button"
          variant="secondary"
        >
          Deny
        </OctantButton>
      </div>
    </section>
  );
}
