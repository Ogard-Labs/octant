import { useCallback, useEffect, useMemo, useState } from "react";
import {
  createMobileChatWithFirstTurn,
  decodeMobileModelOptionId,
  keepDeclaredModelOptionValues,
  RESTRICTED_REMOTE_SESSION,
  type MobileInboxRow,
  type MobileModelOption,
  type MobileRemoteTransport,
} from "@octant/client-runtime";
import type { ProviderModelOptionValues } from "@octant/contracts";
import { presentStaleHostSecurity } from "@octant/domain";
import { MOBILE_COPY, mobileModelLabel } from "../copy";
import { useMobileSession } from "../session/MobileSessionContext";
import type { MobileHostHealthKind } from "../session/MobileHostSessionHub";
import { presentPlacementDisabledReason } from "./placementDisabledReason";
import { chosenReasoningLabel } from "./modelSettings";
import { usePlacementHostModels } from "../session/usePlacementHostModels";
import { selectMobilePlacementTransport } from "./placementTransport";
import { useRemoteSessionStanding } from "./useRemoteSessionStanding";

/**
 * The host new threads go to, its health, and the model chosen for it. Shared
 * by every screen that starts a thread so they cannot drift apart.
 *
 * `fallbackToFirstHost` lets the thread list start a Chat on the first usable
 * host when the remembered placement host is offline; the Home composer must
 * not, because it names the host it will use.
 */
export function usePlacement(options: { readonly fallbackToFirstHost: boolean }) {
  const {
    environment,
    transports,
    hosts,
    placementHostId,
    transportForHost,
    health,
    refreshHosts,
  } = useMobileSession();
  const { fallbackToFirstHost } = options;

  const placementTransport: MobileRemoteTransport | undefined = useMemo(() => {
    if (fallbackToFirstHost && placementHostId !== undefined) {
      return transportForHost(placementHostId) ?? transports[0];
    }
    return selectMobilePlacementTransport({ placementHostId, transports, transportForHost });
  }, [fallbackToFirstHost, placementHostId, transportForHost, transports]);

  const placementStatus = useMemo(
    () => health.find((entry) => entry.hostId === placementTransport?.hostId),
    [health, placementTransport],
  );
  const placementHealth: MobileHostHealthKind =
    placementTransport === undefined ? "idle" : (placementStatus?.kind ?? "idle");
  const placementHealthDetail =
    placementTransport === undefined ? undefined : placementStatus?.detail;
  const placementLabel = useMemo(() => {
    if (placementTransport === undefined) return undefined;
    return hosts.find((host) => host.hostId === placementTransport.hostId)?.label;
  }, [hosts, placementTransport]);
  const staleGate = useMemo(() => presentStaleHostSecurity(placementHealth), [placementHealth]);
  const [accessRefresh, setAccessRefresh] = useState(0);
  const refreshPlacement = useCallback(() => {
    setAccessRefresh((previous) => previous + 1);
    void refreshHosts();
  }, [refreshHosts]);
  const standing = useRemoteSessionStanding(
    placementTransport,
    environment.kind === "mock" && environment.offlineDemo,
    accessRefresh,
  );
  const placementAccessReason =
    placementTransport === undefined || !staleGate.allowProductMutations
      ? undefined
      : standing === RESTRICTED_REMOTE_SESSION
        ? MOBILE_COPY.threadCreationAccessUnconfirmed
        : standing.accessLevel === "read-only"
          ? MOBILE_COPY.threadCreationWatchingOnly
          : undefined;

  const models = usePlacementHostModels(placementTransport);
  const [modelOptionId, setModelOptionIdState] = useState<string | undefined>();
  const [chosenValues, setChosenValues] = useState<ProviderModelOptionValues>({});
  useEffect(() => {
    if (modelOptionId === undefined && models.options[0] !== undefined) {
      setModelOptionIdState(models.options[0].id);
    }
  }, [modelOptionId, models.options]);
  const selectedModel: MobileModelOption | undefined = useMemo(
    () => models.options.find((option) => option.id === modelOptionId),
    [modelOptionId, models.options],
  );
  // A value the model does not declare would make the host refuse the whole
  // request, so only declared ones leave this hook, whichever model was chosen
  // when the person set them.
  const modelOptionValues = useMemo(
    () => keepDeclaredModelOptionValues(selectedModel?.settings, chosenValues),
    [selectedModel, chosenValues],
  );
  const setModelOptionId = useCallback(
    (id: string) => {
      setModelOptionIdState(id);
      const next = models.options.find((option) => option.id === id);
      setChosenValues((previous) => keepDeclaredModelOptionValues(next?.settings, previous));
    },
    [models.options],
  );
  const setModelOptionValue = useCallback((optionId: string, value: string | undefined) => {
    setChosenValues((previous) => {
      const rest = Object.fromEntries(Object.entries(previous).filter(([id]) => id !== optionId));
      return value === undefined ? rest : { ...rest, [optionId]: value };
    });
  }, []);
  const baseModelLabel =
    selectedModel?.label ??
    (models.options.length === 0
      ? MOBILE_COPY.modelUnavailable
      : mobileModelLabel(models.options, models.options[0]?.modelId ?? MOBILE_COPY.modelHostOnly));
  const reasoningLabel = chosenReasoningLabel(selectedModel?.settings, modelOptionValues);
  const modelLabel =
    reasoningLabel === undefined ? baseModelLabel : `${baseModelLabel} · ${reasoningLabel}`;

  const placementDisabledReason =
    placementAccessReason ??
    presentPlacementDisabledReason({
      hostLabel: placementLabel,
      health: placementHealth,
      healthDetail: placementHealthDetail,
      modelsFailed: placementTransport !== undefined && models.error !== undefined,
    });

  /** Callers check the placement host, health, and access first; this only sends. */
  const createChat = useCallback(
    async (
      prompt: string,
      onCreated?: (row: MobileInboxRow) => void,
      typedByPerson?: true,
    ): Promise<MobileInboxRow> => {
      if (placementTransport === undefined) {
        throw new Error("createChat requires a placement host.");
      }
      const decoded =
        modelOptionId === undefined ? undefined : decodeMobileModelOptionId(modelOptionId);
      return createMobileChatWithFirstTurn({
        transport: placementTransport,
        prompt,
        ...(typedByPerson === true ? { typedByPerson } : {}),
        ...(onCreated === undefined ? {} : { onCreated }),
        ...(decoded === undefined
          ? {}
          : { providerInstanceId: decoded.providerInstanceId, modelId: decoded.modelId }),
        ...(Object.keys(modelOptionValues).length === 0 ? {} : { modelOptionValues }),
      });
    },
    [modelOptionId, modelOptionValues, placementTransport],
  );

  return {
    placementTransport,
    placementLabel,
    placementHealth,
    placementAccessReason,
    placementDisabledReason,
    refreshPlacement,
    staleGate,
    models,
    modelOptionId,
    setModelOptionId,
    modelOptionValues,
    setModelOptionValue,
    selectedModel,
    modelLabel,
    createChat,
  };
}
