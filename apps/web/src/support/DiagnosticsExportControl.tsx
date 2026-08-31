import { useId, useState } from "react";
import type { DiagnosticsExportClient } from "@octant/client-runtime/diagnostics-export-client";
import type {
  CorrelationId,
  DiagnosticFailureDomain,
  DiagnosticEvidencePacket,
  DiagnosticsExportOutcome,
} from "@octant/contracts";
import { serializeDiagnosticsEvidencePacket } from "@octant/domain";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantInput } from "../ui/base/OctantInput";
import { OctantSelectField } from "../ui/base/OctantSelect";
import { OctantTextarea } from "../ui/base/OctantTextarea";

/**
 * Browser-first support flow: a local authenticated user picks a
 * failure domain, describes what happened, and gets back a sealed, redacted
 * evidence packet and its bounded receipt — or a typed failure, never a
 * fabricated success. All authority and redaction happen server-side; this
 * component only collects input and renders the outcome the server returned.
 */

const DOMAIN_OPTIONS: ReadonlyArray<{
  readonly id: DiagnosticFailureDomain;
  readonly label: string;
}> = [{ id: "provider", label: "Provider" }];

export interface DiagnosticsExportControlProps {
  readonly client: DiagnosticsExportClient;
}

type ExportState =
  | { readonly kind: "idle" }
  | { readonly kind: "pending" }
  | { readonly kind: "done"; readonly outcome: DiagnosticsExportOutcome }
  | { readonly kind: "error"; readonly message: string };

export function DiagnosticsExportControl({ client }: DiagnosticsExportControlProps) {
  const domainId = useId();
  const correlationIdInputId = useId();
  const summaryId = useId();
  const [domain, setDomain] = useState<DiagnosticFailureDomain>("provider");
  const [correlationId, setCorrelationId] = useState("");
  const [summary, setSummary] = useState("");
  const [state, setState] = useState<ExportState>({ kind: "idle" });

  const onSubmit = async () => {
    setState({ kind: "pending" });
    try {
      const outcome = await client.exportEvidence({
        correlationId: correlationId.trim() as CorrelationId,
        domain,
        summary: summary.trim(),
      });
      if (outcome.kind === "exported") downloadDiagnosticsPacket(outcome.packet);
      setState({ kind: "done", outcome });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Diagnostics export failed for an unknown reason.";
      setState({ kind: "error", message });
    }
  };

  return (
    <div className="settings-view__setting">
      <label className="settings-view__field" htmlFor={domainId}>
        Failure domain
      </label>
      <OctantSelectField
        id={domainId}
        onValueChange={(value) => setDomain(value as DiagnosticFailureDomain)}
        options={DOMAIN_OPTIONS.map((option) => ({
          id: option.id,
          label: option.label,
        }))}
        value={domain}
      />

      <label className="settings-view__field" htmlFor={correlationIdInputId}>
        Failure correlation ID
      </label>
      <OctantInput
        id={correlationIdInputId}
        onChange={(event) => setCorrelationId(event.target.value)}
        placeholder="Paste the correlation ID from the failed operation"
        value={correlationId}
      />

      <label className="settings-view__field" htmlFor={summaryId}>
        Describe what happened
      </label>
      <OctantTextarea
        id={summaryId}
        maxLength={2_000}
        onChange={(event) => setSummary(event.target.value)}
        placeholder="A short safe description. Do not include passwords, keys, tokens, or private content."
        value={summary}
      />

      <OctantButton
        className="settings-view__action"
        disabled={
          summary.trim().length === 0 ||
          !isCorrelationId(correlationId.trim()) ||
          state.kind === "pending"
        }
        onClick={() => {
          void onSubmit();
        }}
        type="button"
        variant="secondary"
      >
        {state.kind === "pending" ? "Exporting…" : "Export diagnostics"}
      </OctantButton>

      {state.kind === "done" ? <DiagnosticsExportOutcomeView outcome={state.outcome} /> : null}
      {state.kind === "error" ? <p role="alert">{state.message}</p> : null}
    </div>
  );
}

const CORRELATION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isCorrelationId(value: string): boolean {
  return CORRELATION_ID_PATTERN.test(value);
}

function downloadDiagnosticsPacket(packet: DiagnosticEvidencePacket): void {
  const blob = new Blob([serializeDiagnosticsEvidencePacket(packet)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `octant-diagnostics-${packet.packetId}.json`;
  anchor.click();
  URL.revokeObjectURL(url);
}

function DiagnosticsExportOutcomeView({ outcome }: { readonly outcome: DiagnosticsExportOutcome }) {
  if (outcome.kind === "failed") {
    return <p role="alert">{outcome.failure.message}</p>;
  }
  return (
    <div aria-live="polite">
      <p>Exported</p>
      <p>Packet id: {outcome.receipt.packetId}</p>
      <p>Redactions applied: {outcome.receipt.redactions.join(", ") || "none"}</p>
    </div>
  );
}
