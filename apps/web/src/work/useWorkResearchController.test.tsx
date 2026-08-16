import { renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { MAX_WORK_RESEARCH_SOURCE_BYTES, decodeProjectId } from "@octant/contracts";
import type {
  WorkResearchBriefView,
  WorkResearchClient,
} from "@octant/client-runtime/work-research-client";
import type { WorkMutationClient } from "@octant/client-runtime/work-mutation-client";
import { useWorkResearchController } from "./useWorkResearchController";

const projectId = decodeProjectId("20000000-0000-4000-8000-000000000001");
const briefId = "30000000-0000-4000-8000-000000000001";
const sourceId = "40000000-0000-4000-8000-000000000001";
const anchor = "anchor-1";

function briefView(overrides: Partial<WorkResearchBriefView> = {}): WorkResearchBriefView {
  return {
    briefId,
    brief: {
      briefId,
      projectId,
      questions: ["What changed?"],
      sourcePolicy: { allowedKinds: ["file"], maxSources: 8, excerptByteBudget: 64_000 },
      status: "gathering",
      version: 3,
    },
    sources: [],
    revokedSourceIds: [],
    evidence: [],
    claims: [],
    ...overrides,
  } as unknown as WorkResearchBriefView;
}

function stubClient(overrides: Partial<WorkResearchClient> = {}): WorkResearchClient {
  return {
    listBriefs: vi.fn().mockResolvedValue([briefView()]),
    execute: vi.fn(),
    ...overrides,
  };
}

function stubMutationClient(outcome: unknown): WorkMutationClient {
  return {
    mutate: vi.fn().mockResolvedValue({ requestId: "r", outcome }),
  } as unknown as WorkMutationClient;
}

const artifactId = "50000000-0000-4000-8000-000000000001";

/** The `created` reply the host returns for the report deliverable. */
function createdOutcome(sequence = 1) {
  return {
    kind: "created",
    artifact: { artifactId, artifactRef: "artifact-ref-1", displayName: "research-report.md" },
    version: { artifactId, sequence },
  };
}

/** A mutation client that answers each mutation kind in turn. */
function routedMutationClient(
  routes: Record<string, ReadonlyArray<unknown> | unknown>,
): WorkMutationClient {
  const remaining = new Map<string, unknown[]>(
    Object.entries(routes).map(([kind, value]) => [
      kind,
      Array.isArray(value) ? [...value] : [value],
    ]),
  );
  return {
    mutate: vi.fn(async (request: { readonly kind: string }) => {
      const queue = remaining.get(request.kind);
      const outcome = queue === undefined ? undefined : queue.length > 1 ? queue.shift() : queue[0];
      if (outcome === undefined) throw new Error(`unexpected mutation: ${request.kind}`);
      if (outcome instanceof Error) throw outcome;
      return { requestId: "r", outcome };
    }),
  } as unknown as WorkMutationClient;
}

describe("useWorkResearchController", () => {
  it("proposes a create-brief command with the panel defaults and reloads on success", async () => {
    const client = stubClient({
      execute: vi.fn().mockResolvedValue({ kind: "brief-created" }),
    });
    const { result } = renderHook(() =>
      useWorkResearchController({ client, enabled: true, projectId }),
    );
    await waitFor(() => {
      expect(result.current.status).toBe("ready");
    });

    const outcome = await result.current.createBrief({ question: "What changed last quarter?" });

    expect(outcome).toEqual({ kind: "accepted" });
    expect(client.execute).toHaveBeenCalledTimes(1);
    const command = vi.mocked(client.execute).mock.calls[0]?.[0];
    expect(command).toMatchObject({
      kind: "create-brief",
      projectId,
      questions: ["What changed last quarter?"],
      deliverables: ["report"],
      sourcePolicy: { allowedKinds: ["file"] },
    });
    // Success re-reads the host projection instead of trusting the proposal.
    await waitFor(() => {
      expect(client.listBriefs).toHaveBeenCalledTimes(2);
    });
  });

  it("rejects a question the shared contract forbids without sending a command", async () => {
    const client = stubClient();
    const { result } = renderHook(() =>
      useWorkResearchController({ client, enabled: true, projectId }),
    );
    await waitFor(() => {
      expect(result.current.status).toBe("ready");
    });

    const outcome = await result.current.createBrief({ question: "read /etc/passwd" });

    expect(outcome.kind).toBe("rejected");
    expect(client.execute).not.toHaveBeenCalled();
  });

  it("records a claim against the loaded brief version so stale clients cannot clobber", async () => {
    const client = stubClient({
      execute: vi.fn().mockResolvedValue({ kind: "claim-recorded" }),
    });
    const { result } = renderHook(() =>
      useWorkResearchController({ client, enabled: true, projectId }),
    );
    await waitFor(() => {
      expect(result.current.status).toBe("ready");
    });

    const outcome = await result.current.recordClaim({ briefId, text: "Revenue grew" });

    expect(outcome).toEqual({ kind: "accepted" });
    expect(client.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "record-claim",
        briefId,
        expectedVersion: 3,
        text: "Revenue grew",
        citationAnchors: [],
      }),
    );
  });

  it("adds a file source with the version it observed so the host can confirm the bytes", async () => {
    const client = stubClient({
      execute: vi.fn().mockResolvedValue({ kind: "source-added" }),
    });
    const { result } = renderHook(() =>
      useWorkResearchController({ client, enabled: true, projectId }),
    );
    await waitFor(() => {
      expect(result.current.status).toBe("ready");
    });

    const outcome = await result.current.addSource({
      briefId,
      file: new File(["hello"], "notes.md"),
      excerpt: "Revenue grew in the third quarter",
    });

    expect(outcome).toEqual({ kind: "accepted" });
    expect(client.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "add-source",
        projectId,
        briefId,
        expectedVersion: 3,
        sourceKind: "file",
        sourceRef: "notes.md",
        displayName: "notes.md",
        excerpt: "Revenue grew in the third quarter",
        sourceVersion: expect.objectContaining({
          // sha256("hello"), so the host compares the same bytes it re-reads.
          contentSha256: "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
          byteSize: 5,
        }),
      }),
    );
    await waitFor(() => {
      expect(client.listBriefs).toHaveBeenCalledTimes(2);
    });
  });

  it("refuses a pick the browser reports inside a subfolder instead of sending its bare basename", async () => {
    const client = stubClient({
      execute: vi.fn().mockResolvedValue({ kind: "source-added" }),
    });
    const nested = new File(["hello"], "q3.md");
    Object.defineProperty(nested, "webkitRelativePath", { value: "notes/q3.md" });
    const { result } = renderHook(() =>
      useWorkResearchController({ client, enabled: true, projectId }),
    );
    await waitFor(() => {
      expect(result.current.status).toBe("ready");
    });

    const outcome = await result.current.addSource({
      briefId,
      file: nested,
      excerpt: "Revenue grew",
    });

    // The host resolves a source name directly beneath the bound folder, so
    // sending `q3.md` for `notes/q3.md` would either fail for a reason the
    // message does not explain or bind the brief to a different file that
    // happens to share the name. The pick is refused, and the message says why.
    expect(outcome.kind).toBe("rejected");
    expect(outcome.kind === "rejected" ? outcome.message : "").toBe(
      "Octant can only use a file that sits directly in the folder Work is bound to, not one inside a subfolder. Move or copy the file to the top level of that folder and pick it again.",
    );
    expect(client.execute).not.toHaveBeenCalled();
  });

  it("refuses an oversized file without reading it into renderer memory", async () => {
    const client = stubClient();
    const arrayBuffer = vi.fn();
    const oversized = {
      name: "archive.md",
      size: MAX_WORK_RESEARCH_SOURCE_BYTES + 1,
      arrayBuffer,
    } as unknown as File;
    const { result } = renderHook(() =>
      useWorkResearchController({ client, enabled: true, projectId }),
    );
    await waitFor(() => {
      expect(result.current.status).toBe("ready");
    });

    const outcome = await result.current.addSource({
      briefId,
      file: oversized,
      excerpt: "Revenue grew",
    });

    expect(outcome).toEqual({
      kind: "rejected",
      message: "That file is larger than the 8 MiB a research source may be, so it was not read.",
    });
    expect(arrayBuffer).not.toHaveBeenCalled();
    expect(client.execute).not.toHaveBeenCalled();
  });

  it("reads and hashes a file at the source limit", async () => {
    const client = stubClient({
      execute: vi.fn().mockResolvedValue({ kind: "source-added" }),
    });
    const { result } = renderHook(() =>
      useWorkResearchController({ client, enabled: true, projectId }),
    );
    await waitFor(() => {
      expect(result.current.status).toBe("ready");
    });

    const outcome = await result.current.addSource({
      briefId,
      file: new File(["hello"], "notes.md"),
      excerpt: "Revenue grew",
    });

    expect(outcome).toEqual({ kind: "accepted" });
    expect(client.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceVersion: expect.objectContaining({
          contentSha256: "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
          byteSize: 5,
        }),
      }),
    );
  });

  it("refuses to propose a source past the brief's own source budget", async () => {
    const client = stubClient({
      listBriefs: vi.fn().mockResolvedValue([
        briefView({
          brief: {
            briefId,
            projectId,
            questions: ["What changed?"],
            sourcePolicy: { allowedKinds: ["file"], maxSources: 1, excerptByteBudget: 64_000 },
            status: "gathering",
            version: 3,
          },
          sources: [{ sourceId }],
        } as unknown as Partial<WorkResearchBriefView>),
      ]),
    });
    const { result } = renderHook(() =>
      useWorkResearchController({ client, enabled: true, projectId }),
    );
    await waitFor(() => {
      expect(result.current.status).toBe("ready");
    });

    const outcome = await result.current.addSource({
      briefId,
      file: new File(["hello"], "notes.md"),
      excerpt: "Revenue grew",
    });

    expect(outcome).toEqual({
      kind: "rejected",
      message: "This brief already holds its maximum of 1 source.",
    });
    expect(client.execute).not.toHaveBeenCalled();
  });

  it("records evidence against a chosen source at the loaded brief version", async () => {
    const client = stubClient({
      execute: vi.fn().mockResolvedValue({ kind: "evidence-recorded" }),
    });
    const { result } = renderHook(() =>
      useWorkResearchController({ client, enabled: true, projectId }),
    );
    await waitFor(() => {
      expect(result.current.status).toBe("ready");
    });

    const outcome = await result.current.recordEvidence({
      briefId,
      sourceId,
      excerpt: "Revenue grew by nine percent",
    });

    expect(outcome).toEqual({ kind: "accepted" });
    const command = vi.mocked(client.execute).mock.calls[0]?.[0];
    expect(command).toMatchObject({
      kind: "record-evidence",
      projectId,
      briefId,
      expectedVersion: 3,
      sourceId,
      excerpt: "Revenue grew by nine percent",
    });
    expect(command).toHaveProperty("citationAnchor");
    expect(command).toHaveProperty("retrievedAt");
    await waitFor(() => {
      expect(client.listBriefs).toHaveBeenCalledTimes(2);
    });
  });

  it("names the changed source file when the host answers stale to evidence", async () => {
    const client = stubClient({
      execute: vi.fn().mockResolvedValue({ kind: "stale", briefId, sourceId }),
    });
    const { result } = renderHook(() =>
      useWorkResearchController({ client, enabled: true, projectId }),
    );
    await waitFor(() => {
      expect(result.current.status).toBe("ready");
    });

    const outcome = await result.current.recordEvidence({
      briefId,
      sourceId,
      excerpt: "Revenue grew",
    });

    expect(outcome).toEqual({
      kind: "rejected",
      message:
        "The source file changed since it was added, so the host refused to record evidence against the version you cited. The brief was reloaded; add the file again to cite its current contents.",
    });
    await waitFor(() => {
      expect(client.listBriefs).toHaveBeenCalledTimes(2);
    });
  });

  it("revokes a source at the loaded brief version", async () => {
    const client = stubClient({
      execute: vi.fn().mockResolvedValue({ kind: "source-revoked" }),
    });
    const { result } = renderHook(() =>
      useWorkResearchController({ client, enabled: true, projectId }),
    );
    await waitFor(() => {
      expect(result.current.status).toBe("ready");
    });

    const outcome = await result.current.revokeSource({ briefId, sourceId });

    expect(outcome).toEqual({ kind: "accepted" });
    expect(client.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "revoke-source",
        projectId,
        briefId,
        expectedVersion: 3,
        sourceId,
      }),
    );
  });

  it("finalizes a report against the artifact the host actually wrote", async () => {
    const client = stubClient({
      execute: vi.fn().mockResolvedValue({ kind: "report-finalized" }),
    });
    const mutationClient = routedMutationClient({ "create-artifact": createdOutcome() });
    const { result } = renderHook(() =>
      useWorkResearchController({ client, enabled: true, mutationClient, projectId }),
    );
    await waitFor(() => {
      expect(result.current.status).toBe("ready");
    });

    const outcome = await result.current.finalizeReport({ briefId });

    expect(outcome).toEqual({ kind: "accepted" });
    // Exactly one artifact mutation: the accepted finalize compensates nothing.
    expect(vi.mocked(mutationClient.mutate)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(mutationClient.mutate)).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "create-artifact", format: "markdown", projectId }),
    );
    expect(client.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "finalize-report",
        projectId,
        briefId,
        expectedVersion: 3,
        producedArtifactRef: "artifact-ref-1",
      }),
    );
    await waitFor(() => {
      expect(client.listBriefs).toHaveBeenCalledTimes(2);
    });
  });

  it("never presents an unsupported claim as cited in the report deliverable", async () => {
    // The host recomputes a claim's support when the source backing it is
    // revoked. The report deliverable must state that loss rather than the
    // citation count the claim was recorded with.
    const client = stubClient({
      listBriefs: vi.fn().mockResolvedValue([
        briefView({
          claims: [
            {
              claimId: "claim-1",
              briefId,
              text: "Revenue grew",
              citationAnchors: [anchor],
              unsupported: true,
            },
          ],
        } as unknown as Partial<WorkResearchBriefView>),
      ]),
      execute: vi.fn().mockResolvedValue({ kind: "report-finalized" }),
    });
    const mutationClient = routedMutationClient({ "create-artifact": createdOutcome() });
    const { result } = renderHook(() =>
      useWorkResearchController({ client, enabled: true, mutationClient, projectId }),
    );
    await waitFor(() => {
      expect(result.current.status).toBe("ready");
    });

    await result.current.finalizeReport({ briefId });

    const written = vi.mocked(mutationClient.mutate).mock.calls[0]?.[0] as {
      readonly content: string;
    };
    expect(written.content).toContain("Revenue grew (unsupported)");
    expect(written.content).not.toContain("citation(s)");
  });

  it("removes the report artifact when the host refuses to finalize the brief", async () => {
    const client = stubClient({
      execute: vi.fn().mockResolvedValue({ kind: "stale", briefId }),
    });
    const mutationClient = routedMutationClient({
      "create-artifact": createdOutcome(),
      "delete-artifact": { kind: "deleted", artifactId },
    });
    const { result } = renderHook(() =>
      useWorkResearchController({ client, enabled: true, mutationClient, projectId }),
    );
    await waitFor(() => {
      expect(result.current.status).toBe("ready");
    });

    const outcome = await result.current.finalizeReport({ briefId });

    // The deliverable must not stay durable while the brief is unfinalized.
    expect(vi.mocked(mutationClient.mutate)).toHaveBeenCalledWith({
      kind: "delete-artifact",
      requestId: expect.any(String),
      projectId,
      artifactId,
      expectedArtifactVersion: 1,
    });
    expect(outcome).toEqual({
      kind: "rejected",
      message:
        "The brief changed on the host. It was reloaded; try again. The report artifact was removed, so no unreferenced report was left behind.",
    });
  });

  it("says the report artifact remains when it cannot be removed, and reuses it on retry", async () => {
    const client = stubClient({
      execute: vi
        .fn()
        .mockResolvedValueOnce({ kind: "stale", briefId })
        .mockResolvedValueOnce({ kind: "report-finalized" }),
    });
    const mutationClient = routedMutationClient({
      "create-artifact": createdOutcome(),
      "delete-artifact": new Error("offline"),
      "revise-artifact": { ...createdOutcome(2), kind: "revised" },
    });
    const { result } = renderHook(() =>
      useWorkResearchController({ client, enabled: true, mutationClient, projectId }),
    );
    await waitFor(() => {
      expect(result.current.status).toBe("ready");
    });

    const rejected = await result.current.finalizeReport({ briefId });

    expect(rejected).toEqual({
      kind: "rejected",
      message:
        "The brief changed on the host. It was reloaded; try again. The report artifact was written and could not be removed, so it remains in the Project; finalizing again updates it instead of writing a second report.",
    });

    const accepted = await result.current.finalizeReport({ briefId });

    expect(accepted).toEqual({ kind: "accepted" });
    // The retry must not write a second artifact over the same filename.
    const kinds = vi
      .mocked(mutationClient.mutate)
      .mock.calls.map((call) => (call[0] as { readonly kind: string }).kind);
    expect(kinds).toEqual(["create-artifact", "delete-artifact", "revise-artifact"]);
    expect(client.execute).toHaveBeenLastCalledWith(
      expect.objectContaining({ kind: "finalize-report", producedArtifactRef: "artifact-ref-1" }),
    );
  });

  it("does not claim the artifact was skipped when the host never answered", async () => {
    const client = stubClient();
    const mutationClient = routedMutationClient({
      "create-artifact": new Error("offline"),
    });
    const { result } = renderHook(() =>
      useWorkResearchController({ client, enabled: true, mutationClient, projectId }),
    );
    await waitFor(() => {
      expect(result.current.status).toBe("ready");
    });

    const outcome = await result.current.finalizeReport({ briefId });

    expect(outcome).toEqual({
      kind: "rejected",
      message:
        "The host did not confirm the report artifact, so the brief was not finalized. Check the Project for a report file before finalizing again.",
    });
    expect(client.execute).not.toHaveBeenCalled();
  });

  it("does not finalize a brief when the host declines to write the report artifact", async () => {
    const client = stubClient();
    const mutationClient = stubMutationClient({ kind: "unauthorized" });
    const { result } = renderHook(() =>
      useWorkResearchController({ client, enabled: true, mutationClient, projectId }),
    );
    await waitFor(() => {
      expect(result.current.status).toBe("ready");
    });

    const outcome = await result.current.finalizeReport({ briefId });

    expect(outcome).toEqual({
      kind: "rejected",
      message: "The host declined to write the report artifact, so the brief was not finalized.",
    });
    expect(client.execute).not.toHaveBeenCalled();
  });

  it("cites the evidence anchors the user selected instead of recording an anchorless claim", async () => {
    const client = stubClient({
      execute: vi.fn().mockResolvedValue({ kind: "claim-recorded" }),
    });
    const { result } = renderHook(() =>
      useWorkResearchController({ client, enabled: true, projectId }),
    );
    await waitFor(() => {
      expect(result.current.status).toBe("ready");
    });

    const outcome = await result.current.recordClaim({
      briefId,
      text: "Revenue grew",
      citationAnchors: [anchor],
    });

    expect(outcome).toEqual({ kind: "accepted" });
    expect(client.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "record-claim",
        briefId,
        expectedVersion: 3,
        text: "Revenue grew",
        citationAnchors: [anchor],
      }),
    );
  });

  it("relays a typed host denial as a rejected outcome and resyncs on stale", async () => {
    const client = stubClient({
      execute: vi.fn().mockResolvedValue({ kind: "stale", briefId, sourceId: briefId }),
    });
    const { result } = renderHook(() =>
      useWorkResearchController({ client, enabled: true, projectId }),
    );
    await waitFor(() => {
      expect(result.current.status).toBe("ready");
    });

    const outcome = await result.current.recordClaim({ briefId, text: "Revenue grew" });

    expect(outcome).toEqual({
      kind: "rejected",
      message: "The brief changed on the host. It was reloaded; try again.",
    });
    await waitFor(() => {
      expect(client.listBriefs).toHaveBeenCalledTimes(2);
    });
  });
});
