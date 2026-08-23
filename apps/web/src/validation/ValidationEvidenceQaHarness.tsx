import { createValidationEvidenceClient } from "@octant/client-runtime/validation-evidence-client";
import {
  decodeValidationEvidenceRequest,
  type ValidationEvidenceRequest,
} from "@octant/contracts/validation-rpc";
import { StrictMode, useMemo } from "react";
import { createRoot } from "react-dom/client";
import "../styles.css";
import { ValidationEvidencePane } from "./ValidationEvidencePane";
import { useValidationEvidence } from "./useValidationEvidence";
import { OctantButton } from "../ui/base/OctantButton";

const DEFAULT_AUTHORITY = {
  hostId: "00000000-0000-4000-8000-000000000001",
  mode: "code",
  projectId: "00000000-0000-4000-8000-000000000002",
  providerInstanceId: "00000000-0000-4000-8000-000000000003",
  extension: { kind: "core" },
} as const;

function ValidationEvidenceQaHarness() {
  const parameters = useMemo(() => new URLSearchParams(globalThis.location.search), []);
  const client = useMemo(
    () =>
      createValidationEvidenceClient({
        baseUrl: parameters.get("server") ?? "http://127.0.0.1:4176",
        fetch: globalThis.fetch,
        windowCapability:
          parameters.get("capability") ?? "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      }),
    [parameters],
  );
  const request = useMemo<ValidationEvidenceRequest>(() => {
    const providerInstanceId = parameters.get("provider") ?? DEFAULT_AUTHORITY.providerInstanceId;
    const afterSequence = parameters.get("afterSequence");
    return decodeValidationEvidenceRequest({
      authority: { ...DEFAULT_AUTHORITY, providerInstanceId },
      ...(afterSequence === null ? {} : { afterSequence: Number(afterSequence) }),
    });
  }, [parameters]);
  const state = useValidationEvidence({ client, request });

  return (
    <main className="validation-qa">
      <header className="validation-qa__header">
        <h1>Validation evidence</h1>
        <OctantButton onClick={state.retry} type="button" variant="outline">
          Reconnect
        </OctantButton>
      </header>
      <div data-validation-status={state.status}>
        <ValidationEvidencePane
          status={state.status}
          {...(state.snapshot === undefined ? {} : { snapshot: state.snapshot })}
          {...(state.errorMessage === undefined ? {} : { errorMessage: state.errorMessage })}
          onRetry={state.retry}
        />
      </div>
    </main>
  );
}

const root = document.getElementById("root");
if (root === null) throw new Error("Validation QA root is missing.");
createRoot(root).render(
  <StrictMode>
    <ValidationEvidenceQaHarness />
  </StrictMode>,
);
