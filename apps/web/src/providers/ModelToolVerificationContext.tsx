import type { ProviderInstanceId, ProviderModelId } from "@octant/contracts";
import { createContext, useContext } from "react";
import type { ModelToolVerification } from "./useProviderController";

/**
 * The one explicit request that proves whether a model calls tools. Held in
 * context so every model picker can offer it on a Chat-only model without each
 * composer threading the provider controller down to it. Absent where the
 * provider authority is not reachable, which hides the action.
 */
export type ModelToolVerifier = (
  providerInstanceId: ProviderInstanceId,
  modelId: ProviderModelId,
) => Promise<ModelToolVerification>;

export const ModelToolVerificationContext = createContext<ModelToolVerifier | undefined>(undefined);

export function useModelToolVerifier(): ModelToolVerifier | undefined {
  return useContext(ModelToolVerificationContext);
}
