import type { AgentRunResultPacket } from "@octant/contracts";
import { ChevronDown } from "lucide-react";
import { useId, useState, type ReactNode } from "react";
import { Markdown } from "../markdown/Markdown";
import { OctantButton } from "../ui/base/OctantButton";
import { subagentStatusWord } from "./subagentStatus";
import type { AgentResultReviewRequest } from "../gitHistory/SavedAgentReview";

export function latestResultPacket(
  packets: ReadonlyArray<AgentRunResultPacket>,
): AgentRunResultPacket | undefined {
  return packets.reduce<AgentRunResultPacket | undefined>(
    (latest, packet) =>
      latest === undefined || packet.generation > latest.generation ? packet : latest,
    undefined,
  );
}

/** A short parent-thread preview; attribution always comes from this packet. */
export function AgentResultPreview(props: { readonly packet: AgentRunResultPacket }) {
  const packet = props.packet;
  const summary = packet.reportedSummary;
  return (
    <span className="agent-result-preview">
      <span>
        Generation {packet.generation} · {packet.modelId}
      </span>
      <span>
        {summary.status === "available" && summary.text !== undefined
          ? `Summary preview: ${summary.text.slice(0, 160)}${summary.text.length > 160 || summary.truncated ? "…" : ""}`
          : "Summary unavailable"}
      </span>
      <span>
        {packet.files.status === "unavailable"
          ? "Files unavailable"
          : `${packet.files.items.length} ${packet.files.items.length === 1 ? "file" : "files"} reported · unverified${packet.files.status === "truncated" ? " · list truncated" : ""}`}
      </span>
      <span>
        {evidenceCount("Checks", packet.checks)} · {evidenceCount("Blockers", packet.blockers)}
      </span>
    </span>
  );
}

export function AgentRunResults(props: {
  readonly packets: ReadonlyArray<AgentRunResultPacket> | undefined;
  readonly truncated: boolean;
  readonly onReviewChanges?: (request: AgentResultReviewRequest) => void;
}) {
  const latest = latestResultPacket(props.packets ?? []);
  return (
    <section aria-label="Attributed results" className="agent-results">
      <h3>Result history</h3>
      {props.truncated ? (
        <p className="agent-run-detail__note">Earlier results are not retained.</p>
      ) : null}
      {props.packets === undefined ? (
        <p className="agent-run-detail__note">Attributed result history is unavailable.</p>
      ) : props.packets.length === 0 ? (
        <p className="agent-run-detail__note">No results recorded yet.</p>
      ) : (
        props.packets.map((packet) => (
          <ResultPacket
            key={packet.generation}
            packet={packet}
            initiallyOpen={packet.generation === latest?.generation}
            {...(props.onReviewChanges === undefined
              ? {}
              : { onReviewChanges: props.onReviewChanges })}
          />
        ))
      )}
    </section>
  );
}

function ResultPacket(props: {
  readonly packet: AgentRunResultPacket;
  readonly initiallyOpen: boolean;
  readonly onReviewChanges?: (request: AgentResultReviewRequest) => void;
}) {
  const [open, setOpen] = useState(props.initiallyOpen);
  const contentId = useId();
  const packet = props.packet;
  const canReview =
    packet.workspace.kind === "code-worktree" &&
    packet.files.reviewStatus === "available" &&
    packet.review !== undefined &&
    props.onReviewChanges !== undefined;
  return (
    <section aria-label={`Generation ${packet.generation} result`} className="agent-result">
      <OctantButton
        aria-expanded={open}
        aria-controls={open ? contentId : undefined}
        className="agent-result__toggle"
        onClick={() => setOpen((value) => !value)}
        size="xs"
        variant="ghost"
      >
        Generation {packet.generation} · Execution {subagentStatusWord(packet.lifecycleStatus)} ·{" "}
        {packet.modelId}
        <ChevronDown aria-hidden="true" size={12} />
      </OctantButton>
      {open ? (
        <div id={contentId} className="agent-result__body">
          <h4>Reported summary</h4>
          {packet.reportedSummary.status === "available" &&
          packet.reportedSummary.text !== undefined ? (
            <Markdown body={packet.reportedSummary.text} className="chat-rich-text" />
          ) : (
            <p>Summary unavailable</p>
          )}
          {packet.reportedSummary.truncated ? <p>Summary truncated.</p> : null}
          {packet.reportedSummary.reference === undefined ? null : (
            <EvidenceReference
              label="Summary reference"
              reference={packet.reportedSummary.reference}
            />
          )}
          <h4>Files</h4>
          <p>
            {packet.files.status === "unavailable"
              ? "File reports unavailable."
              : packet.files.items.length === 0
                ? "No files reported."
                : "Provider reported · unverified"}
          </p>
          {packet.files.status === "truncated" ? <p>File list is truncated.</p> : null}
          {canReview ? (
            <OctantButton
              variant="secondary"
              size="sm"
              onClick={() => props.onReviewChanges?.({ packet })}
            >
              Review changes
            </OctantButton>
          ) : (
            <p>File review unavailable.</p>
          )}
          <ul>
            {packet.files.items.map((file, index) => (
              <li key={`${file.reference}:${index}`}>
                <p>
                  {canReview && packet.review?.changedPaths.includes(file.path) ? (
                    <OctantButton
                      className="agent-result__file"
                      variant="link"
                      size="xs"
                      aria-label={`Review ${file.path}`}
                      onClick={() => props.onReviewChanges?.({ packet, filePath: file.path })}
                    >
                      {file.path}
                    </OctantButton>
                  ) : (
                    file.path
                  )}{" "}
                  · {file.change}
                </p>
                {canReview && !packet.review?.changedPaths.includes(file.path) ? (
                  <p>
                    {packet.review?.truncated
                      ? "Not in the retained part of the captured changes."
                      : "Not listed in captured changes."}
                  </p>
                ) : null}
                <EvidenceReference label="File reference" reference={file.reference} />
              </li>
            ))}
          </ul>
          <h4>Checks</h4>
          <p>{evidenceCount("Checks", packet.checks)}</p>
          <ul>
            {packet.checks.items.map((check, index) => (
              <li key={`${check.reference}:${index}`}>
                <p>
                  {check.label} · {check.outcome} · Host recorded
                </p>
                <ResultDisclosure label="Check evidence">
                  {check.toolExecution === undefined ? (
                    <p>Recorded output unavailable.</p>
                  ) : (
                    <>
                      <p>
                        {check.toolExecution.toolName} ·{" "}
                        {check.toolExecution.isError ? "Tool returned an error" : "Tool completed"}
                      </p>
                      <pre className="agent-result__output">{check.toolExecution.output}</pre>
                      {check.toolExecution.truncated ? <p>Recorded output is truncated.</p> : null}
                    </>
                  )}
                  <p className="agent-run-detail__note">
                    Reference: <code>{check.reference}</code>
                  </p>
                </ResultDisclosure>
              </li>
            ))}
          </ul>
          <h4>Blockers</h4>
          <p>{evidenceCount("Blockers", packet.blockers)}</p>
          <ul>
            {packet.blockers.items.map((blocker, index) => (
              <li key={`${blocker.reference}:${index}`}>
                <p>{blocker.text} · Lifecycle record</p>
                <EvidenceReference label="Blocker reference" reference={blocker.reference} />
              </li>
            ))}
          </ul>
          <ResultDisclosure label="Attribution">
            <p>
              Run: {packet.runId} · Parent: {packet.parentThreadId}
            </p>
            <p>
              Provider ID: {packet.providerInstanceId} · Model: {packet.modelId}
            </p>
            <p>
              Execution: {packet.executionKind} · Recorded: {packet.occurredAt}
            </p>
            <p>{agentResultWorkspaceLabel(packet)}</p>
          </ResultDisclosure>
        </div>
      ) : null}
    </section>
  );
}

export function ResultDisclosure(props: { readonly label: string; readonly children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <div>
      <OctantButton
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={() => setOpen((value) => !value)}
        size="xs"
        variant="ghost"
      >
        {props.label}
        <ChevronDown aria-hidden="true" size={12} />
      </OctantButton>
      {open ? (
        <div id={id} className="agent-result__evidence">
          {props.children}
        </div>
      ) : null}
    </div>
  );
}

function EvidenceReference(props: { readonly label: string; readonly reference: string }) {
  return (
    <ResultDisclosure label={props.label}>
      <code>{props.reference}</code>
    </ResultDisclosure>
  );
}

function evidenceCount(
  label: string,
  evidence: { readonly status: string; readonly items: ReadonlyArray<unknown> },
): string {
  return evidence.status === "unavailable"
    ? `${label} unavailable`
    : `${label}: ${evidence.items.length} recorded${evidence.status === "truncated" ? " · list truncated" : ""}`;
}

export function agentResultWorkspaceLabel(packet: AgentRunResultPacket): string {
  const workspace = packet.workspace;
  if (workspace.kind === "chat-virtual") return "Workspace: virtual chat; no filesystem workspace.";
  if (workspace.kind === "work-root")
    return `Workspace: ${workspace.canonicalRoot} · Binding: ${workspace.bindingRevisionId}`;
  return `Workspace: ${workspace.worktreeRoot} · Checkout: ${workspace.checkoutRoot} · ${workspace.verified ? "Verified workspace receipt" : "Unverified workspace receipt"}`;
}
