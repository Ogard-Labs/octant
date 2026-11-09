import { useLayoutEffect, useRef, useState } from "react";
import type { OwnerPostureTarget, OwnerPosture } from "@octant/contracts";
import {
  ownerPostureLabel,
  ownerPostureLevels,
  readOwnerPostures,
  changeOwnerPosture,
  ownerActionNotice,
  type OwnerSpoke,
} from "@octant/client-runtime";
import { SettingsSection, SettingsState } from "../settings/primitives";
import { OctantSelectField } from "../ui/base/OctantSelect";
import { OctantButton } from "../ui/base/OctantButton";

export function OwnerPostureSection({ spokes }: { readonly spokes: ReadonlyArray<OwnerSpoke> }) {
  const [hostId, setHostId] = useState(spokes[0]?.memberId ?? "");
  const [targets, setTargets] = useState<ReadonlyArray<OwnerPostureTarget>>([]);
  const [targetKey, setTargetKey] = useState("");
  const [requested, setRequested] = useState<OwnerPosture["posture"]>("approval-gated");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const host = spokes.find((spoke) => spoke.memberId === hostId) ?? spokes[0];
  const generation = useRef(0);
  const selected = targets.find((target) => JSON.stringify(target.posture.subject) === targetKey);
  // Invalidate before paint: a replacement client must never display or apply
  // a reading captured by the previous member/client, even at the same member id.
  useLayoutEffect(() => {
    generation.current += 1;
    setHostId(host?.memberId ?? "");
    setTargets([]);
    setTargetKey("");
    setMessage("");
    setBusy(false);
    return () => {
      generation.current += 1;
    };
  }, [host?.memberId, host?.client, host?.openAt]);
  const load = async () => {
    if (host === undefined || busy) return;
    const operation = ++generation.current;
    setBusy(true);
    setTargets([]);
    setTargetKey("");
    setMessage("");
    const result = await readOwnerPostures(host.client);
    if (operation !== generation.current) return;
    if (result.status === "read") {
      setTargets(result.targets);
      setMessage(
        result.targets.length === 0
          ? "No active Work or Code targets on this host."
          : "Choose the Work thread, Code thread or Code Project to change.",
      );
    } else setMessage(result.message);
    setBusy(false);
  };
  const apply = async () => {
    if (host === undefined || selected === undefined || busy || host.openAt !== undefined) return;
    const operation = ++generation.current;
    setBusy(true);
    const result = await changeOwnerPosture(host.client, selected.posture, requested);
    if (operation !== generation.current) return;
    // A spent or uncertain proof never leaves an Apply button over cached state.
    setTargets([]);
    setTargetKey("");
    setMessage(
      ownerActionNotice(result, "Level changed. Refresh to read the current level.").message,
    );
    setBusy(false);
  };
  if (spokes.length === 0) return null;
  const levels = ownerPostureLevels(selected?.posture);
  return (
    <SettingsSection title="Owner access recovery">
      <p className="settings-section-line">
        Change a Work or Code thread's level, or a Code Project's remembered Full access. Full
        access asks for a fresh unlock for this choice. Running turns keep their current level.
      </p>
      <label>
        Computer
        <OctantSelectField
          aria-label="Recovery computer"
          disabled={busy}
          value={host?.memberId ?? ""}
          options={spokes.map((spoke) => ({ id: spoke.memberId, label: spoke.name }))}
          onValueChange={setHostId}
        />
      </label>
      {host?.openAt === undefined ? (
        <>
          <OctantButton
            type="button"
            variant="secondary"
            disabled={busy || host === undefined}
            onClick={() => void load()}
          >
            Refresh access levels
          </OctantButton>
          {targets.length === 0 ? null : (
            <label>
              Recovery target
              <OctantSelectField
                aria-label="Recovery target"
                disabled={busy}
                value={targetKey}
                options={[
                  { id: "", label: "Choose a target" },
                  ...targets.map((target) => ({
                    id: JSON.stringify(target.posture.subject),
                    label: `${target.posture.subject.kind === "project" ? "Project" : target.posture.subject.kind === "work-thread" ? "Work thread" : "Thread"}: ${target.title}`,
                  })),
                ]}
                onValueChange={(key) => {
                  setTargetKey(key);
                  const target = targets.find(
                    (entry) => JSON.stringify(entry.posture.subject) === key,
                  );
                  setRequested(target?.posture.posture ?? "approval-gated");
                  setMessage("");
                }}
              />
            </label>
          )}
          {selected === undefined ? null : (
            <>
              <p>Current level: {ownerPostureLabel(selected.posture)}</p>
              <label>
                Requested level
                <OctantSelectField
                  aria-label="Requested level"
                  disabled={busy}
                  value={requested}
                  options={levels.map((policy) => ({
                    id: policy,
                    label: ownerPostureLabel(selected.posture, policy),
                  }))}
                  onValueChange={(value) => {
                    const policy = levels.find((entry) => entry === value);
                    if (policy !== undefined) setRequested(policy);
                  }}
                />
              </label>
              <OctantButton
                type="button"
                disabled={busy || requested === selected.posture.posture}
                onClick={() => void apply()}
              >
                Apply level
              </OctantButton>
            </>
          )}
        </>
      ) : (
        <a href={host.openAt} target="_blank" rel="noopener noreferrer">
          Open {host.name} to change access levels
        </a>
      )}
      {message === "" ? null : <SettingsState kind="empty">{message}</SettingsState>}
      {busy ? <p role="status">Waiting for this host and your unlock…</p> : null}
    </SettingsSection>
  );
}
