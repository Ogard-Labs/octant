import type { AgentRunClient } from "@octant/client-runtime/agent-run-client";
import type { CanvasClient } from "@octant/client-runtime/canvas-client";
import type { PlanClient } from "@octant/client-runtime/plan-client";
import type { ShipClient } from "@octant/client-runtime/ship-client";
import { decodeAgentRunParentThreadId } from "@octant/contracts/agent-run";
import type { OctantMode } from "@octant/contracts/modes";
import type { ProjectId } from "@octant/contracts/projects";
import { useEffect, useState } from "react";
import {
  hasActionableDelivery,
  isAuthorizedCanvasDocument,
  isCurrentPlanArtifact,
  type DockToolCapabilities,
} from "./dockToolAvailability";

export interface UseDockToolCapabilitiesOptions {
  readonly agentRunClient?: AgentRunClient;
  readonly addAgentInvoked: boolean;
  readonly canvasClient?: CanvasClient;
  readonly hasAppleSimulator: boolean;
  readonly mode: OctantMode;
  readonly planClient?: PlanClient;
  readonly projectId?: ProjectId;
  readonly shipClient?: ShipClient;
  readonly threadId?: string;
}

interface ThreadFlag {
  readonly threadId?: string;
  readonly value: boolean | "unknown";
}

const UNKNOWN_FLAG: ThreadFlag = { value: "unknown" };

export function useDockToolCapabilities(
  options: UseDockToolCapabilitiesOptions,
): DockToolCapabilities {
  const [plan, setPlan] = useState<ThreadFlag>(UNKNOWN_FLAG);
  const [delivery, setDelivery] = useState<ThreadFlag>(UNKNOWN_FLAG);
  const [canvas, setCanvas] = useState<ThreadFlag>(UNKNOWN_FLAG);
  const [childRuns, setChildRuns] = useState<ThreadFlag>(UNKNOWN_FLAG);
  const { agentRunClient, canvasClient, mode, planClient, projectId, shipClient, threadId } =
    options;

  useEffect(() => {
    let alive = true;
    if (threadId === undefined || planClient === undefined) {
      setPlan({ ...(threadId === undefined ? {} : { threadId }), value: false });
      return () => {
        alive = false;
      };
    }
    setPlan({ threadId, value: "unknown" });
    void planClient
      .read(threadId)
      .then((projection) => {
        if (alive) setPlan({ threadId, value: isCurrentPlanArtifact(projection.plan) });
      })
      .catch(() => {
        if (alive) setPlan({ threadId, value: false });
      });
    return () => {
      alive = false;
    };
  }, [planClient, threadId]);

  useEffect(() => {
    let alive = true;
    if (threadId === undefined || shipClient === undefined) {
      setDelivery({ ...(threadId === undefined ? {} : { threadId }), value: false });
      return () => {
        alive = false;
      };
    }
    setDelivery({ threadId, value: "unknown" });
    void shipClient
      .targets()
      .then((targets) => {
        if (alive) setDelivery({ threadId, value: hasActionableDelivery({ targets }) });
      })
      .catch(() => {
        if (alive) setDelivery({ threadId, value: false });
      });
    return () => {
      alive = false;
    };
  }, [shipClient, threadId]);

  useEffect(() => {
    let alive = true;
    if (threadId === undefined || canvasClient === undefined) {
      setCanvas({ ...(threadId === undefined ? {} : { threadId }), value: false });
      return () => {
        alive = false;
      };
    }
    setCanvas({ threadId, value: "unknown" });
    void canvasClient
      .threadReferenceCards({
        mode,
        threadId,
        projectId: projectId ?? null,
      })
      .then((outcome) => {
        if (alive) {
          setCanvas({ threadId, value: outcome.cards.some(isAuthorizedCanvasDocument) });
        }
      })
      .catch(() => {
        if (alive) setCanvas({ threadId, value: false });
      });
    return () => {
      alive = false;
    };
  }, [canvasClient, mode, projectId, threadId]);

  useEffect(() => {
    let alive = true;
    if (threadId === undefined || agentRunClient === undefined) {
      setChildRuns({ ...(threadId === undefined ? {} : { threadId }), value: false });
      return () => {
        alive = false;
      };
    }
    setChildRuns({ threadId, value: "unknown" });
    let parentThreadId;
    try {
      parentThreadId = decodeAgentRunParentThreadId(threadId);
    } catch {
      setChildRuns({ threadId, value: false });
      return () => {
        alive = false;
      };
    }
    void agentRunClient
      .parentSummary(parentThreadId)
      .then((summary) => {
        if (alive) setChildRuns({ threadId, value: summary.entries.length > 0 });
      })
      .catch(() => {
        if (alive) setChildRuns({ threadId, value: false });
      });
    return () => {
      alive = false;
    };
  }, [agentRunClient, threadId]);

  if (threadId === undefined) {
    return {
      hasPlanArtifact: false,
      hasDelivery: false,
      hasCanvasDocument: false,
      hasAppleSimulator: false,
      hasChildRuns: false,
      addAgentInvoked: false,
    };
  }
  return {
    hasPlanArtifact: plan.threadId === threadId ? plan.value : "unknown",
    hasDelivery: delivery.threadId === threadId ? delivery.value : "unknown",
    hasCanvasDocument: canvas.threadId === threadId ? canvas.value : "unknown",
    hasAppleSimulator: options.hasAppleSimulator,
    hasChildRuns: childRuns.threadId === threadId ? childRuns.value : "unknown",
    addAgentInvoked: options.addAgentInvoked,
  };
}
