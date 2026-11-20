import type { AgentRunResultPacket } from "@octant/contracts";

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

export function evidenceCount(
  label: string,
  evidence: { readonly status: string; readonly items: ReadonlyArray<unknown> },
): string {
  return evidence.status === "unavailable"
    ? `${label} unavailable`
    : `${label}: ${evidence.items.length} recorded${evidence.status === "truncated" ? " · list truncated" : ""}`;
}
