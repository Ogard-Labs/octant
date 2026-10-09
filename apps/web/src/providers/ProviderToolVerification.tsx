import type { ProviderInstance, ProviderModelId, ProviderObservedState } from "@octant/contracts";
import { useState } from "react";
import { OctantButton } from "../ui/base/OctantButton";
import type { ModelToolVerification } from "./useProviderController";

export interface ProviderToolVerificationProps {
  readonly instance: ProviderInstance;
  readonly observed: ProviderObservedState | undefined;
  readonly disabled: boolean;
  readonly onVerify: (
    instanceId: ProviderInstance["id"],
    modelId: ProviderModelId,
  ) => Promise<ModelToolVerification>;
}

/** The models a provider card offers a "Verify tools" action for: the ones set up by hand. */
function configuredModelIds(instance: ProviderInstance): ReadonlyArray<ProviderModelId> {
  switch (instance.configuration.kind) {
    case "openai-compatible-http":
    case "anthropic-compatible-http":
    case "azure-foundry-openai-http":
      return instance.configuration.manualModelIds;
    default:
      return [];
  }
}

/**
 * Octant only sends its own tools to a model it has seen call one. A routine
 * Check connection runs no generating request, so a person proves it per
 * model here. Each click sends one request the endpoint may bill.
 */
export function ProviderToolVerification(props: ProviderToolVerificationProps) {
  const [verifying, setVerifying] = useState<string>();
  const verified = props.observed?.verifiedToolModelIds ?? [];
  const modelIds = configuredModelIds(props.instance);
  const noun = props.instance.driverKind === "azure-foundry" ? "deployment" : "model";
  return (
    <>
      <span>
        Tool support:{" "}
        <strong>
          {verified.length > 0
            ? `Verified (${verified.length} ${noun}${verified.length > 1 ? "s" : ""})`
            : `Chat only until you verify a ${noun}`}
        </strong>
      </span>
      {modelIds.length === 0 ? (
        <span>
          Verify tools for a model from the model picker, or beside it in Model roles once a role
          uses it. Each check sends one request.
        </span>
      ) : (
        <>
          <span>
            {noun === "deployment" ? "Deployments" : "Models"} (verifying sends one request each):
          </span>
          {modelIds.map((modelId) => {
            const isVerified = verified.some((id) => String(id) === String(modelId));
            const active = verifying === String(modelId);
            return (
              <span key={String(modelId)}>
                <OctantButton
                  disabled={props.disabled || verifying !== undefined}
                  onClick={() => {
                    setVerifying(String(modelId));
                    void props.onVerify(props.instance.id, modelId).finally(() => {
                      setVerifying(undefined);
                    });
                  }}
                  size="sm"
                  type="button"
                  variant="outline"
                >
                  {active
                    ? "Verifying…"
                    : `Verify tools for ${modelId}${isVerified ? " (verified)" : ""}`}
                </OctantButton>
              </span>
            );
          })}
        </>
      )}
    </>
  );
}
