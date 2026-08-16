import {
  LOCAL_HOST_ID,
  decodeChatThreadId,
  decodeProjectId,
  decodeProviderInstanceId,
  decodeZenThreadCatalogEntry,
  decodeZenThreadCatalogRef,
} from "@octant/contracts";

export const threadId = decodeChatThreadId("00000000-0000-4000-8000-000000000001");
export const catalogRef = decodeZenThreadCatalogRef(`chat:${threadId}`);
export const entry = decodeZenThreadCatalogEntry({
  catalogRef,
  hostId: LOCAL_HOST_ID,
  hostLabel: "This Mac",
  mode: "chat",
  projectId: decodeProjectId("00000000-0000-4000-8000-000000000002"),
  projectLabel: "AuroraDocs",
  threadId,
  title: "Release blocker",
  status: "active",
  recentActivityAt: "2026-07-28T12:00:00.000Z",
  providerInstanceId: decodeProviderInstanceId("00000000-0000-4000-8000-000000000003"),
  modelId: "model-local",
  sourceContext: {
    hostId: LOCAL_HOST_ID,
    mode: "chat",
    projectId: "00000000-0000-4000-8000-000000000002",
    threadKind: "chat",
    threadId,
  },
});
