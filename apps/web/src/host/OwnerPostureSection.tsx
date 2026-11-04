import { useEffect, useState } from "react";
import type { OwnerPostureTarget, ProviderExecutionPolicy } from "@octant/contracts";
import {
  OWNER_POSTURE_LABELS,
  ownerPostureLabel,
  readOwnerPostures,
  changeOwnerPosture,
  ownerActionNotice,
  type OwnerSpoke,
} from "@octant/client-runtime";
import { SettingsSection, SettingsState } from "../settings/primitives";
import { OctantButton } from "../ui/base/OctantButton";

export function OwnerPostureSection({ spokes }: { readonly spokes: ReadonlyArray<OwnerSpoke> }) {
  const [hostId, setHostId] = useState(spokes[0]?.memberId ?? "");
  const [targets, setTargets] = useState<ReadonlyArray<OwnerPostureTarget>>([]);
  const [targetKey, setTargetKey] = useState("");
  const [requested, setRequested] = useState<ProviderExecutionPolicy>("approval-gated");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const host = spokes.find((spoke) => spoke.memberId === hostId);
  const selected = targets.find((target) => JSON.stringify(target.posture.subject) === targetKey);
  useEffect(() => {
    setTargets([]);
    setTargetKey("");
    setMessage("");
  }, [hostId]);
  const load = async () => {
    if (host === undefined || busy) return;
    setBusy(true);
    setTargets([]);
    setTargetKey("");
    setMessage("");
    const result = await readOwnerPostures(host.client);
    if (result.status === "read") {
      setTargets(result.targets);
      setMessage(
        result.targets.length === 0
          ? "No active Code targets on this host."
          : "Choose the Code thread or Project to change.",
      );
    } else setMessage(result.message);
    setBusy(false);
  };
  const apply = async () => {
    if (host === undefined || selected === undefined || busy || host.openAt !== undefined) return;
    setBusy(true);
    const result = await changeOwnerPosture(host.client, selected.posture, requested);
    // A spent or uncertain proof never leaves an Apply button over cached state.
    setTargets([]);
    setTargetKey("");
    setMessage(
      ownerActionNotice(result, "Level changed. Refresh to read the current level.").message,
    );
    setBusy(false);
  };
  if (spokes.length === 0) return null;
  return (
    <SettingsSection title="Owner Code recovery">
      <p className="settings-section-line">
        Change a Code thread's level or a Project's remembered Full access. Full access asks for a
        fresh unlock for this choice. Running turns keep their current level.
      </p>
      <label>
        Computer{" "}
        <select
          aria-label="Code recovery computer"
          disabled={busy}
          value={hostId}
          onChange={(event) => setHostId(event.target.value)}
        >
          {spokes.map((spoke) => (
            <option key={spoke.memberId} value={spoke.memberId}>
              {spoke.name}
            </option>
          ))}
        </select>
      </label>
      {host?.openAt === undefined ? (
        <>
          <OctantButton
            type="button"
            variant="secondary"
            disabled={busy || host === undefined}
            onClick={() => void load()}
          >
            Refresh Code levels
          </OctantButton>
          {targets.length === 0 ? null : (
            <label>
              Code target{" "}
              <select
                aria-label="Code recovery target"
                disabled={busy}
                value={targetKey}
                onChange={(event) => {
                  const key = event.target.value;
                  setTargetKey(key);
                  const target = targets.find(
                    (entry) => JSON.stringify(entry.posture.subject) === key,
                  );
                  setRequested(target?.posture.posture ?? "approval-gated");
                  setMessage("");
                }}
              >
                <option value="">Choose a target</option>
                {targets.map((target) => (
                  <option
                    key={JSON.stringify(target.posture.subject)}
                    value={JSON.stringify(target.posture.subject)}
                  >
                    {target.posture.subject.kind === "project" ? "Project" : "Thread"}:{" "}
                    {target.title}
                  </option>
                ))}
              </select>
            </label>
          )}
          {selected === undefined ? null : (
            <>
              <p>Current level: {ownerPostureLabel(selected.posture)}</p>
              <label>
                Requested level{" "}
                <select
                  aria-label="Requested Code level"
                  disabled={busy}
                  value={requested}
                  onChange={(event) => {
                    const policy = Object.keys(OWNER_POSTURE_LABELS).find(
                      (key) => key === event.target.value,
                    );
                    if (policy !== undefined) setRequested(policy as ProviderExecutionPolicy);
                  }}
                >
                  {(selected.posture.subject.kind === "project"
                    ? (["approval-gated", "full-access"] as const)
                    : (["approval-gated", "auto-accept-edits", "plan", "full-access"] as const)
                  ).map((policy) => (
                    <option key={policy} value={policy}>
                      {ownerPostureLabel(selected.posture, policy)}
                    </option>
                  ))}
                </select>
              </label>
              <OctantButton
                type="button"
                disabled={busy || requested === selected.posture.posture}
                onClick={() => void apply()}
              >
                Apply Code level
              </OctantButton>
            </>
          )}
        </>
      ) : (
        <a href={host.openAt} target="_blank" rel="noopener noreferrer">
          Open {host.name} to change Code levels
        </a>
      )}
      {message === "" ? null : <SettingsState kind="empty">{message}</SettingsState>}
      {busy ? <p role="status">Waiting for this host and your unlock…</p> : null}
    </SettingsSection>
  );
}
