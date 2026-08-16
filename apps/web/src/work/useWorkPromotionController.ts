import {
  WorkPromotionClientFailure,
  createWorkPromotionClient,
  type WorkPromotionClient,
} from "@octant/client-runtime/work-promotion-client";
import {
  decodeWorkArtifactRef,
  decodeWorkPromotionProposalId,
  type CodeDeliveryTarget,
  type WorkPromotionProposal,
  type WorkPromotionProposalId,
  type ProjectId,
  type ProviderInstanceId,
  type ProviderModelId,
} from "@octant/contracts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

export interface WorkPromotionControllerOptions {
  readonly client?: WorkPromotionClient;
  readonly originProjectId?: ProjectId;
  readonly serverUrl: string;
  readonly targetCodeProjects: ReadonlyArray<ProjectId>;
  readonly windowCapability: string;
  readonly uuid?: () => string;
}

export interface WorkPromotionController {
  readonly errorMessage?: string;
  readonly availableArtifactRefs: ReadonlyArray<string>;
  readonly deliveryTargetsByProject: ReadonlyMap<string, CodeDeliveryTarget>;
  readonly pendingProposals: ReadonlyArray<WorkPromotionProposal>;
  readonly proposing: boolean;
  readonly reload: () => Promise<void>;
  readonly propose: (input: {
    readonly targetCodeProjectId: ProjectId;
    readonly summary: string;
    readonly artifactRefs: ReadonlyArray<string>;
  }) => Promise<WorkPromotionProposal | undefined>;
  readonly approve: (input: {
    readonly proposal: WorkPromotionProposal;
    readonly providerInstanceId: ProviderInstanceId;
    readonly modelId: ProviderModelId;
    readonly deliveryTarget: CodeDeliveryTarget;
  }) => Promise<WorkPromotionProposal | undefined>;
  readonly dismiss: (proposal: WorkPromotionProposal) => Promise<boolean>;
}

export function useWorkPromotionController(
  options: WorkPromotionControllerOptions,
): WorkPromotionController {
  const client = useMemo(
    () =>
      options.client ??
      createWorkPromotionClient({
        baseUrl: options.serverUrl,
        fetch: globalThis.fetch,
        windowCapability: options.windowCapability,
      }),
    [options.client, options.serverUrl, options.windowCapability],
  );
  const uuid = options.uuid ?? globalThis.crypto.randomUUID.bind(globalThis.crypto);
  const [pendingProposals, setPendingProposals] = useState<ReadonlyArray<WorkPromotionProposal>>(
    [],
  );
  const [availableArtifactRefs, setAvailableArtifactRefs] = useState<ReadonlyArray<string>>([]);
  const [deliveryTargetsByProject, setDeliveryTargetsByProject] = useState<
    ReadonlyMap<string, CodeDeliveryTarget>
  >(new Map());
  const [errorMessage, setErrorMessage] = useState<string | undefined>(undefined);
  const [proposing, setProposing] = useState(false);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const reload = useCallback(async () => {
    if (options.originProjectId === undefined) {
      setPendingProposals([]);
      setAvailableArtifactRefs([]);
      setDeliveryTargetsByProject(new Map());
      return;
    }
    try {
      const list = await client.list(options.originProjectId);
      if (!alive.current) return;
      setPendingProposals(list.proposals.filter((proposal) => proposal.status === "proposed"));
      setAvailableArtifactRefs(list.artifactRefs);
      setDeliveryTargetsByProject(
        new Map(
          list.deliveryTargets.map((entry) => [String(entry.projectId), entry.deliveryTarget]),
        ),
      );
      setErrorMessage(undefined);
    } catch (error) {
      if (!alive.current) return;
      setErrorMessage(readFailureMessage(error));
    }
  }, [client, options.originProjectId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const propose = useCallback<WorkPromotionController["propose"]>(
    async (input) => {
      if (options.originProjectId === undefined || proposing) return undefined;
      setProposing(true);
      setErrorMessage(undefined);
      try {
        const result = await client.execute({
          kind: "propose-work-promotion",
          proposalId: decodeWorkPromotionProposalId(uuid()),
          originProjectId: options.originProjectId,
          targetCodeProjectId: input.targetCodeProjectId,
          selectedContext: {
            summary: input.summary,
            artifactRefs: input.artifactRefs.map((ref) => decodeWorkArtifactRef(ref)),
          },
          proposedCodePermissionPersistence: "current-session",
        });
        if (result.kind !== "work-promotion-proposed") return undefined;
        await reload();
        return result.proposal;
      } catch (error) {
        setErrorMessage(readFailureMessage(error));
        return undefined;
      } finally {
        setProposing(false);
      }
    },
    [client, options.originProjectId, proposing, reload, uuid],
  );

  const approve = useCallback<WorkPromotionController["approve"]>(
    async (input) => {
      setErrorMessage(undefined);
      try {
        const result = await client.execute({
          kind: "approve-work-promotion",
          proposalId: input.proposal.proposalId,
          expectedVersion: input.proposal.version,
          providerInstanceId: input.providerInstanceId,
          modelId: input.modelId,
          deliveryTarget: input.deliveryTarget,
        });
        if (result.kind !== "work-promotion-approved") return undefined;
        await reload();
        return result.proposal;
      } catch (error) {
        setErrorMessage(readFailureMessage(error));
        return undefined;
      }
    },
    [client, reload],
  );

  const dismiss = useCallback<WorkPromotionController["dismiss"]>(
    async (proposal) => {
      setErrorMessage(undefined);
      try {
        const result = await client.execute({
          kind: "dismiss-work-promotion",
          proposalId: proposal.proposalId,
          expectedVersion: proposal.version,
        });
        if (result.kind !== "work-promotion-dismissed") return false;
        await reload();
        return true;
      } catch (error) {
        setErrorMessage(readFailureMessage(error));
        return false;
      }
    },
    [client, reload],
  );

  return {
    pendingProposals,
    availableArtifactRefs,
    deliveryTargetsByProject,
    proposing,
    reload,
    propose,
    approve,
    dismiss,
    ...(errorMessage === undefined ? {} : { errorMessage }),
  };
}

function readFailureMessage(error: unknown): string {
  if (error instanceof WorkPromotionClientFailure) return error.message;
  return "Work promotion is unavailable.";
}

export type { WorkPromotionProposalId };
