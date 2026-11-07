import { useLayoutEffect, useRef, useState } from "react";
import type { OwnerApprovalTarget } from "@octant/contracts/owner-approvals";
import {
  readOwnerApprovals,
  answerOwnerApproval,
  ownerActionNotice,
  type OwnerSpoke,
} from "@octant/client-runtime";
import { SettingsSection, SettingsState } from "../settings/primitives";
import { OctantSelectField } from "../ui/base/OctantSelect";
import { OctantButton } from "../ui/base/OctantButton";

export function OwnerApprovalSection({ spokes }: { readonly spokes: ReadonlyArray<OwnerSpoke> }) {
  const [hostId, setHostId] = useState(spokes[0]?.memberId ?? "");
  const host = spokes.find((entry) => entry.memberId === hostId) ?? spokes[0];
  const [targets, setTargets] = useState<ReadonlyArray<OwnerApprovalTarget>>([]);
  const [selectedId, setSelectedId] = useState("");
  const selected = targets.find((entry) => String(entry.requestId) === selectedId);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const generation = useRef(0);
  useLayoutEffect(() => {
    generation.current += 1;
    setTargets([]);
    setSelectedId("");
    setMessage("");
    setBusy(false);
    return () => {
      generation.current += 1;
    };
  }, [host?.memberId, host?.client, host?.openAt]);
  const load = async () => {
    if (host === undefined || busy || host.openAt !== undefined) return;
    const operation = ++generation.current;
    setBusy(true);
    setTargets([]);
    setSelectedId("");
    setMessage("");
    const result = await readOwnerApprovals(host.client);
    if (operation !== generation.current) return;
    if (result.status === "read") {
      setTargets(result.reading.targets);
      setMessage(
        result.reading.unavailable > 0
          ? `${result.reading.unavailable} waiting request(s) cannot be recovered: complete supported file-action details are unavailable. Shell, credentials, Browser, publishing and Git administration stay excluded. Answer those prompts in their thread on the host.`
          : result.reading.targets.length === 0
            ? "No recoverable approvals are waiting on this host."
            : "Choose one approval and read its full action before answering.",
      );
    } else setMessage(result.message);
    setBusy(false);
  };
  const answer = async (approved: boolean) => {
    if (host === undefined || selected === undefined || busy || host.openAt !== undefined) return;
    const operation = ++generation.current;
    setBusy(true);
    const result = await answerOwnerApproval(host.client, selected, approved);
    if (operation !== generation.current) return;
    setTargets([]);
    setSelectedId("");
    const status =
      result.status === "done" &&
      typeof result.body === "object" &&
      result.body !== null &&
      "status" in result.body
        ? result.body.status
        : undefined;
    setMessage(
      status === "uncertain"
        ? "The answer may have reached the runtime. It will not be retried. Check this thread on its host."
        : ownerActionNotice(
            result,
            "Answer delivered once. Refresh to read any remaining approvals.",
          ).message,
    );
    setBusy(false);
  };
  if (host === undefined) return null;
  return (
    <SettingsSection title="Owner approval recovery">
      <p className="settings-section-line">
        Recover one waiting Code or Work file-action approval. Reading private details needs an
        unlock; Allow once and Deny each need a new unlock for that exact answer. Nothing is
        remembered.
      </p>
      <label>
        Computer
        <OctantSelectField
          aria-label="Approval computer"
          disabled={busy}
          value={host.memberId}
          options={spokes.map((entry) => ({ id: entry.memberId, label: entry.name }))}
          onValueChange={setHostId}
        />
      </label>
      {host.openAt !== undefined ? (
        <a href={host.openAt} target="_blank" rel="noopener noreferrer">
          Open {host.name} to recover approvals
        </a>
      ) : (
        <>
          <OctantButton
            type="button"
            variant="secondary"
            disabled={busy}
            onClick={() => void load()}
          >
            Unlock and read approvals
          </OctantButton>
          {targets.length === 0 ? null : (
            <label>
              Waiting approval
              <OctantSelectField
                aria-label="Waiting approval"
                disabled={busy}
                value={selectedId}
                options={[
                  { id: "", label: "Choose an approval" },
                  ...targets.map((entry) => ({
                    id: String(entry.requestId),
                    label: `${entry.mode === "code" ? "Code" : "Work"}: ${entry.title} — ${entry.action.tool}`,
                  })),
                ]}
                onValueChange={setSelectedId}
              />
            </label>
          )}
          {selected === undefined ? null : (
            <>
              <p>
                Runs on {host.name} · {selected.mode === "code" ? "Code" : "Work"} ·{" "}
                {selected.projectName} · {selected.title}
              </p>
              <p>
                Action: {selected.action.tool}
                {selected.action.workingDirectory === undefined
                  ? ""
                  : ` · Working folder: ${selected.action.workingDirectory}`}
              </p>
              <pre className="owner-approval-action">
                {JSON.stringify(JSON.parse(selected.action.input), null, 2)}
              </pre>
              <OctantButton type="button" disabled={busy} onClick={() => void answer(true)}>
                Unlock and allow once
              </OctantButton>
              <OctantButton
                type="button"
                variant="secondary"
                disabled={busy}
                onClick={() => void answer(false)}
              >
                Unlock and deny
              </OctantButton>
            </>
          )}
        </>
      )}
      {message === "" ? null : <SettingsState kind="empty">{message}</SettingsState>}
      {busy ? <p role="status">Waiting for this host and your fresh unlock…</p> : null}
    </SettingsSection>
  );
}
