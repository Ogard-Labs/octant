import { useCallback, useEffect, useRef, useState } from "react";
import {
  MAX_WORK_RESEARCH_EXCERPT_BYTES,
  MAX_WORK_RESEARCH_SOURCE_BYTES,
  decodeWorkMutationRequestId,
  decodeWorkResearchCommand,
  type WorkArtifactId,
  type WorkResearchCommand,
  type WorkResearchCommandResult,
  type ProjectId,
} from "@octant/contracts";
import type {
  WorkResearchBriefView,
  WorkResearchClient,
} from "@octant/client-runtime/work-research-client";
import { WorkResearchClientFailure } from "@octant/client-runtime/work-research-client";
import type { WorkMutationClient } from "@octant/client-runtime/work-mutation-client";

export type WorkResearchStatus =
  | "idle"
  | "loading"
  | "ready"
  | "unauthorized"
  | "unavailable"
  | "failure";

export interface UseWorkResearchControllerOptions {
  readonly client: WorkResearchClient | undefined;
  readonly enabled: boolean;
  readonly projectId: ProjectId | undefined;
  /**
   * Optional Work mutation client used only to produce the report artifact a
   * `finalize-report` command must reference. `WorkResearchReport` requires a
   * `producedArtifactRef`, and the research surface may not invent one, so the
   * deliverable is created through the ordinary Work artifact workflow first
   * and the finalize command cites the artifact the host actually wrote.
   */
  readonly mutationClient?: WorkMutationClient | undefined;
}

/**
 * Outcome of one proposed research command. `accepted` means the host
 * journaled the transition and the briefs were reloaded; `rejected` carries a
 * sanitized human-readable reason. The renderer never derives brief state from
 * an outcome — it always re-reads the host projection.
 */
export type WorkResearchMutationOutcome =
  | { readonly kind: "accepted" }
  | { readonly kind: "rejected"; readonly message: string };

export interface WorkResearchController {
  readonly briefs: ReadonlyArray<WorkResearchBriefView>;
  readonly status: WorkResearchStatus;
  readonly reload: () => void;
  readonly createBrief: (input: {
    readonly question: string;
  }) => Promise<WorkResearchMutationOutcome>;
  readonly addSource: (input: {
    readonly briefId: string;
    readonly file: File;
    readonly excerpt: string;
  }) => Promise<WorkResearchMutationOutcome>;
  readonly revokeSource: (input: {
    readonly briefId: string;
    readonly sourceId: string;
  }) => Promise<WorkResearchMutationOutcome>;
  readonly recordEvidence: (input: {
    readonly briefId: string;
    readonly sourceId: string;
    readonly excerpt: string;
  }) => Promise<WorkResearchMutationOutcome>;
  readonly recordClaim: (input: {
    readonly briefId: string;
    readonly text: string;
    readonly citationAnchors?: ReadonlyArray<string>;
  }) => Promise<WorkResearchMutationOutcome>;
  readonly finalizeReport: (input: {
    readonly briefId: string;
  }) => Promise<WorkResearchMutationOutcome>;
}

/**
 * Default source policy proposed for a brief created from the panel. Only
 * Project-root file sources are allowed until the user widens the policy
 * through a richer affordance; the server re-validates every proposal, so this
 * default can only narrow, never grant, authority.
 */
const PANEL_SOURCE_POLICY = {
  allowedKinds: ["file"],
  maxSources: 8,
  excerptByteBudget: MAX_WORK_RESEARCH_EXCERPT_BYTES,
} as const;

const FAILURE_COPY: Record<string, string> = {
  unauthorized: "The host declined the research command for this window.",
  stale: "The brief changed on the host. It was reloaded; try again.",
  conflict: "The brief conflicts with newer host state. It was reloaded; try again.",
  "not-found": "The brief no longer exists on the host.",
  unsupported: "The host does not support this research action.",
  interrupted: "The research command was interrupted before completing.",
  failed: "The research command failed on the host.",
};

/**
 * Per-command failure copy. The host answers with one shared typed code for
 * several honest situations — `unsupported` also covers a file it cannot read
 * inside the approved folder, and `stale` also covers a source whose bytes
 * changed after it was added — so each transition names the outcome the user
 * actually hit instead of the generic sentence. The host is still the only
 * authority; this only renames the same typed denial.
 */
const ADD_SOURCE_FAILURE_COPY: Record<string, string> = {
  unsupported:
    "The host could not read that file at the top level of the folder Work is bound to. Only a file that sits directly in that folder — not in a subfolder and not elsewhere on this Mac — can become a source.",
  stale: "The file changed while it was being added. Nothing was recorded; try again.",
  conflict: "That file is already a source on this brief, or the brief's source budget is full.",
};

const RECORD_EVIDENCE_FAILURE_COPY: Record<string, string> = {
  unsupported: "The host could not re-read the source file, so no evidence was recorded.",
  stale:
    "The source file changed since it was added, so the host refused to record evidence against the version you cited. The brief was reloaded; add the file again to cite its current contents.",
  unauthorized: "The host declined to record evidence against that source.",
};

const RESYNC_FAILURES = new Set(["stale", "conflict", "not-found"]);

/** Names the shared host limit in the refusal instead of restating a number. */
const SOURCE_LIMIT_LABEL = `${MAX_WORK_RESEARCH_SOURCE_BYTES / 1024 / 1024} MiB`;

/**
 * Refusal for a pick the browser reports inside a folder. A research source is
 * named by a `WorkSourceRef`, which carries no path separator, and the host
 * resolves it directly beneath the bound Project folder; nothing in a browser
 * file pick can name a deeper location, so the honest answer is to say which
 * files can become sources rather than to send a name that means another file.
 */
const SUBFOLDER_PICK_REJECTION =
  "Octant can only use a file that sits directly in the folder Work is bound to, not one inside a subfolder. Move or copy the file to the top level of that folder and pick it again.";

/**
 * Does the browser report a containing folder for this pick? `File.name` is a
 * basename by construction, and `webkitRelativePath` is empty for an ordinary
 * file pick, so this is true only when the pick genuinely came from a folder
 * (a directory input or a dropped folder entry) — exactly the case where
 * sending the basename alone would silently mean a different file.
 */
function namesSubfolderPick(file: File): boolean {
  const reportedPath = typeof file.webkitRelativePath === "string" ? file.webkitRelativePath : "";
  return /[\\/]/.test(file.name) || /[\\/]/.test(reportedPath);
}

/**
 * Observe a picked file the way the host does, so `add-source` can carry the
 * `PreviewSourceVersion` the contract requires. The renderer's observation is
 * never trusted: the host re-reads the same basename inside the approved
 * Project root and answers `stale` when the bytes differ, so a file picked
 * from outside the folder can only fail, never widen authority.
 */
async function observeFileVersion(
  file: File,
): Promise<{ contentSha256: string; byteSize: number; observedAt: string }> {
  const bytes = await file.arrayBuffer();
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  const contentSha256 = Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return { contentSha256, byteSize: bytes.byteLength, observedAt: new Date().toISOString() };
}

/**
 * Markdown deliverable for a finalized brief. The report artifact is written
 * through the ordinary Work artifact workflow, so `finalize-report` cites an
 * artifact the host actually produced instead of a fabricated ref.
 */
function buildReportMarkdown(view: WorkResearchBriefView): string {
  const sourceNames = new Map(
    view.sources.map((source) => [String(source.sourceId), source.displayName]),
  );
  const lines = ["# Research report", "", "## Questions", ""];
  for (const question of view.brief.questions) lines.push(`- ${question}`);
  lines.push("", "## Claims", "");
  for (const claim of view.claims) {
    lines.push(
      `- ${claim.text} (${
        claim.unsupported ? "unsupported" : `${claim.citationAnchors.length} citation(s)`
      })`,
    );
  }
  lines.push("", "## Evidence", "");
  for (const entry of view.evidence) {
    const name = sourceNames.get(String(entry.sourceId)) ?? "unknown source";
    lines.push(`- ${name}: ${entry.excerpt}`);
  }
  return lines.join("\n");
}

/**
 * A report deliverable the host wrote for a brief that is not finalized yet.
 * Held only until the brief finalizes or the artifact is removed again.
 */
interface DraftReportArtifact {
  readonly artifactId: WorkArtifactId;
  readonly sequence: number;
  readonly artifactRef: string;
}

type ReportArtifactWrite =
  | { readonly kind: "written"; readonly artifact: DraftReportArtifact }
  /** The host answered a typed refusal; nothing was written. */
  | { readonly kind: "declined" }
  /** The request never produced an answer; the host state is unknown. */
  | { readonly kind: "unavailable" };

/**
 * Write the report deliverable `finalize-report` must cite.
 *
 * A brief whose previous attempt left an uncompensated draft revises that same
 * artifact instead of creating a second one, so a retry can never overwrite the
 * earlier report's file behind a second artifact identity. A revise the host
 * refuses (the draft was removed or moved on) falls back to a fresh create,
 * which is the honest outcome once the draft is no longer there.
 */
async function writeReportArtifact(input: {
  readonly mutationClient: WorkMutationClient;
  readonly projectId: ProjectId;
  readonly content: string;
  readonly displayName: string;
  readonly draft: DraftReportArtifact | undefined;
}): Promise<ReportArtifactWrite> {
  try {
    if (input.draft !== undefined) {
      const revised = await input.mutationClient.mutate({
        kind: "revise-artifact",
        requestId: decodeWorkMutationRequestId(globalThis.crypto.randomUUID()),
        projectId: input.projectId,
        artifactId: input.draft.artifactId,
        content: input.content,
        expectedArtifactVersion: input.draft.sequence,
      });
      if (revised.outcome.kind === "revised") {
        return {
          kind: "written",
          artifact: {
            artifactId: revised.outcome.artifact.artifactId,
            sequence: revised.outcome.version.sequence,
            artifactRef: String(revised.outcome.artifact.artifactRef),
          },
        };
      }
    }
    const created = await input.mutationClient.mutate({
      kind: "create-artifact",
      requestId: decodeWorkMutationRequestId(globalThis.crypto.randomUUID()),
      projectId: input.projectId,
      format: "markdown",
      displayName: input.displayName,
      content: input.content,
    });
    if (created.outcome.kind !== "created") return { kind: "declined" };
    return {
      kind: "written",
      artifact: {
        artifactId: created.outcome.artifact.artifactId,
        sequence: created.outcome.version.sequence,
        artifactRef: String(created.outcome.artifact.artifactRef),
      },
    };
  } catch {
    return { kind: "unavailable" };
  }
}

/**
 * Compensate a report artifact the host wrote for a brief it then refused to
 * finalize. Returns whether the artifact is gone; the caller must say which
 * happened rather than imply the deliverable exists or does not.
 */
async function removeReportArtifact(input: {
  readonly mutationClient: WorkMutationClient;
  readonly projectId: ProjectId;
  readonly artifact: DraftReportArtifact;
}): Promise<boolean> {
  try {
    const reply = await input.mutationClient.mutate({
      kind: "delete-artifact",
      requestId: decodeWorkMutationRequestId(globalThis.crypto.randomUUID()),
      projectId: input.projectId,
      artifactId: input.artifact.artifactId,
      expectedArtifactVersion: input.artifact.sequence,
    });
    return reply.outcome.kind === "deleted";
  } catch {
    return false;
  }
}

/**
 * Controller for the authoritative Work research surface.
 *
 * Briefs are always re-read from the host; the renderer never derives
 * provenance locally. A superseded load is discarded by generation so a slow
 * response for a previous Project can never repaint another Project's research.
 * Mutations only propose commands: the renderer decodes the proposal against
 * the shared contract for early honest feedback, but the server re-validates
 * authority, policy, and provenance before any side effect.
 */
export function useWorkResearchController(
  options: UseWorkResearchControllerOptions,
): WorkResearchController {
  const [briefs, setBriefs] = useState<ReadonlyArray<WorkResearchBriefView>>([]);
  const [status, setStatus] = useState<WorkResearchStatus>("idle");
  const [reloadToken, setReloadToken] = useState(0);
  const generation = useRef(0);
  /** Report artifacts written for briefs the host has not finalized yet. */
  const drafts = useRef(new Map<string, DraftReportArtifact>());

  const reload = useCallback(() => {
    setReloadToken((token) => token + 1);
  }, []);

  useEffect(() => {
    const operation = ++generation.current;
    const { client, enabled, projectId } = options;
    if (!enabled || client === undefined || projectId === undefined) {
      setBriefs([]);
      setStatus("idle");
      return;
    }
    const controller = new AbortController();
    setStatus("loading");
    void client
      .listBriefs(projectId, controller.signal)
      .then((loaded) => {
        if (generation.current !== operation) return;
        setBriefs(loaded);
        setStatus("ready");
      })
      .catch((error: unknown) => {
        if (generation.current !== operation) return;
        setBriefs([]);
        if (error instanceof WorkResearchClientFailure) {
          setStatus(
            error.status === 401 ? "unauthorized" : error.status === 0 ? "unavailable" : "failure",
          );
          return;
        }
        setStatus("failure");
      });
    return () => {
      controller.abort();
    };
  }, [options.client, options.enabled, options.projectId, reloadToken]);

  const propose = useCallback(
    async (
      command: WorkResearchCommand,
      copy?: Record<string, string>,
    ): Promise<WorkResearchMutationOutcome> => {
      const { client } = options;
      if (client === undefined) {
        return { kind: "rejected", message: "Research is unavailable for this Project." };
      }
      let result: WorkResearchCommandResult;
      try {
        result = await client.execute(command);
      } catch (error: unknown) {
        if (error instanceof WorkResearchClientFailure) {
          return { kind: "rejected", message: error.message };
        }
        return { kind: "rejected", message: "The research command could not be sent." };
      }
      const failureCopy = copy?.[result.kind] ?? FAILURE_COPY[result.kind];
      if (failureCopy !== undefined) {
        if (RESYNC_FAILURES.has(result.kind)) reload();
        return { kind: "rejected", message: failureCopy };
      }
      reload();
      return { kind: "accepted" };
    },
    [options.client, reload],
  );

  /**
   * Resolve the loaded brief a transition targets. Every brief transition
   * carries the loaded `version` as `expectedVersion`, so a client that missed
   * a host transition is refused as `stale` instead of clobbering it.
   */
  const resolveBrief = useCallback(
    (briefId: string): WorkResearchBriefView | undefined =>
      briefs.find((candidate) => String(candidate.briefId) === briefId),
    [briefs],
  );

  const createBrief = useCallback(
    async (input: { readonly question: string }): Promise<WorkResearchMutationOutcome> => {
      const { enabled, projectId } = options;
      if (!enabled || projectId === undefined) {
        return { kind: "rejected", message: "Research is unavailable for this Project." };
      }
      let command: WorkResearchCommand;
      try {
        command = decodeWorkResearchCommand({
          kind: "create-brief",
          requestId: globalThis.crypto.randomUUID(),
          projectId,
          briefId: globalThis.crypto.randomUUID(),
          questions: [input.question],
          sourcePolicy: PANEL_SOURCE_POLICY,
          deliverables: ["report"],
        });
      } catch {
        return {
          kind: "rejected",
          message: "Research questions cannot be empty or contain paths or links.",
        };
      }
      return await propose(command);
    },
    [options.enabled, options.projectId, propose],
  );

  const addSource = useCallback(
    async (input: {
      readonly briefId: string;
      readonly file: File;
      readonly excerpt: string;
    }): Promise<WorkResearchMutationOutcome> => {
      const { enabled, projectId } = options;
      if (!enabled || projectId === undefined) {
        return { kind: "rejected", message: "Research is unavailable for this Project." };
      }
      const view = resolveBrief(input.briefId);
      if (view === undefined) {
        return { kind: "rejected", message: "The brief is not loaded. Reload and try again." };
      }
      // The brief's own policy is the narrower bound; the host re-checks it.
      const policy = view.brief.sourcePolicy;
      if (!policy.allowedKinds.includes("file")) {
        return { kind: "rejected", message: "This brief does not accept file sources." };
      }
      // Revoking a source keeps it in the recorded set on the host, so the
      // budget the panel checks is the same one the host enforces.
      if (view.sources.length >= policy.maxSources) {
        return {
          kind: "rejected",
          message: `This brief already holds its maximum of ${policy.maxSources} source${
            policy.maxSources === 1 ? "" : "s"
          }.`,
        };
      }
      // A browser file pick carries a basename, and the host resolves that name
      // directly beneath the bound folder, so `notes/q3.md` and a top-level
      // `q3.md` would arrive as the same token. When the browser does report a
      // containing folder, the pick is refused with the rule that decided it
      // rather than truncated into a name that means a different file. A pick
      // the browser reports as a bare name is still sent, and the host's
      // content check refuses it unless the top-level file's bytes match.
      if (namesSubfolderPick(input.file)) {
        return { kind: "rejected", message: SUBFOLDER_PICK_REJECTION };
      }
      // Checked before the bytes are touched: the host treats a larger file as
      // unobservable and can only answer `unsupported`, so reading it first
      // would spend renderer memory on a pick that cannot succeed.
      if (input.file.size > MAX_WORK_RESEARCH_SOURCE_BYTES) {
        return {
          kind: "rejected",
          message: `That file is larger than the ${SOURCE_LIMIT_LABEL} a research source may be, so it was not read.`,
        };
      }
      let sourceVersion: Awaited<ReturnType<typeof observeFileVersion>>;
      try {
        sourceVersion = await observeFileVersion(input.file);
      } catch {
        return { kind: "rejected", message: "The selected file could not be read." };
      }
      let command: WorkResearchCommand;
      try {
        command = decodeWorkResearchCommand({
          kind: "add-source",
          requestId: globalThis.crypto.randomUUID(),
          projectId,
          briefId: input.briefId,
          expectedVersion: view.brief.version,
          sourceId: globalThis.crypto.randomUUID(),
          sourceKind: "file",
          sourceRef: input.file.name,
          displayName: input.file.name,
          excerpt: input.excerpt,
          citationAnchor: globalThis.crypto.randomUUID(),
          sourceVersion,
        });
      } catch {
        return {
          kind: "rejected",
          message:
            "The source excerpt cannot be empty or contain paths, links, addresses, or credentials.",
        };
      }
      return await propose(command, ADD_SOURCE_FAILURE_COPY);
    },
    [options.enabled, options.projectId, propose, resolveBrief],
  );

  const revokeSource = useCallback(
    async (input: {
      readonly briefId: string;
      readonly sourceId: string;
    }): Promise<WorkResearchMutationOutcome> => {
      const { enabled, projectId } = options;
      if (!enabled || projectId === undefined) {
        return { kind: "rejected", message: "Research is unavailable for this Project." };
      }
      const view = resolveBrief(input.briefId);
      if (view === undefined) {
        return { kind: "rejected", message: "The brief is not loaded. Reload and try again." };
      }
      let command: WorkResearchCommand;
      try {
        command = decodeWorkResearchCommand({
          kind: "revoke-source",
          requestId: globalThis.crypto.randomUUID(),
          projectId,
          briefId: input.briefId,
          expectedVersion: view.brief.version,
          sourceId: input.sourceId,
        });
      } catch {
        return { kind: "rejected", message: "That source cannot be revoked." };
      }
      return await propose(command);
    },
    [options.enabled, options.projectId, propose, resolveBrief],
  );

  const recordEvidence = useCallback(
    async (input: {
      readonly briefId: string;
      readonly sourceId: string;
      readonly excerpt: string;
    }): Promise<WorkResearchMutationOutcome> => {
      const { enabled, projectId } = options;
      if (!enabled || projectId === undefined) {
        return { kind: "rejected", message: "Research is unavailable for this Project." };
      }
      const view = resolveBrief(input.briefId);
      if (view === undefined) {
        return { kind: "rejected", message: "The brief is not loaded. Reload and try again." };
      }
      let command: WorkResearchCommand;
      try {
        command = decodeWorkResearchCommand({
          kind: "record-evidence",
          requestId: globalThis.crypto.randomUUID(),
          projectId,
          briefId: input.briefId,
          expectedVersion: view.brief.version,
          evidenceId: globalThis.crypto.randomUUID(),
          sourceId: input.sourceId,
          // The anchor is opaque and only has to be stable: claims cite
          // evidence by anchor, so the panel mints one per evidence entry.
          citationAnchor: globalThis.crypto.randomUUID(),
          excerpt: input.excerpt,
          retrievedAt: new Date().toISOString(),
        });
      } catch {
        return {
          kind: "rejected",
          message:
            "The evidence excerpt cannot be empty or contain paths, links, addresses, or credentials.",
        };
      }
      return await propose(command, RECORD_EVIDENCE_FAILURE_COPY);
    },
    [options.enabled, options.projectId, propose, resolveBrief],
  );

  const recordClaim = useCallback(
    async (input: {
      readonly briefId: string;
      readonly text: string;
      readonly citationAnchors?: ReadonlyArray<string>;
    }): Promise<WorkResearchMutationOutcome> => {
      const { enabled, projectId } = options;
      if (!enabled || projectId === undefined) {
        return { kind: "rejected", message: "Research is unavailable for this Project." };
      }
      const view = resolveBrief(input.briefId);
      if (view === undefined) {
        return { kind: "rejected", message: "The brief is not loaded. Reload and try again." };
      }
      let command: WorkResearchCommand;
      try {
        command = decodeWorkResearchCommand({
          kind: "record-claim",
          requestId: globalThis.crypto.randomUUID(),
          projectId,
          briefId: input.briefId,
          expectedVersion: view.brief.version,
          claimId: globalThis.crypto.randomUUID(),
          text: input.text,
          // Anchors of the evidence the user selected. A claim recorded with
          // none is honestly flagged unsupported by the host, and the panel
          // renders it as such.
          citationAnchors: input.citationAnchors ?? [],
        });
      } catch {
        return {
          kind: "rejected",
          message: "Claims cannot be empty or contain paths or links.",
        };
      }
      return await propose(command);
    },
    [options.enabled, options.projectId, propose, resolveBrief],
  );

  const finalizeReport = useCallback(
    async (input: { readonly briefId: string }): Promise<WorkResearchMutationOutcome> => {
      const { enabled, mutationClient, projectId } = options;
      if (!enabled || projectId === undefined) {
        return { kind: "rejected", message: "Research is unavailable for this Project." };
      }
      if (mutationClient === undefined) {
        return {
          kind: "rejected",
          message: "Producing the report artifact is unavailable in this window.",
        };
      }
      const view = resolveBrief(input.briefId);
      if (view === undefined) {
        return { kind: "rejected", message: "The brief is not loaded. Reload and try again." };
      }
      // The report must cite an artifact the host actually wrote, so the
      // deliverable is produced through the ordinary Work artifact workflow
      // before the brief is finalized. A written deliverable the host then
      // refuses to finalize is compensated below, so the write is never durable
      // on its own.
      const write = await writeReportArtifact({
        mutationClient,
        projectId,
        content: buildReportMarkdown(view),
        displayName: `research-report-${input.briefId.slice(0, 8)}.md`,
        draft: drafts.current.get(input.briefId),
      });
      if (write.kind === "declined") {
        return {
          kind: "rejected",
          message:
            "The host declined to write the report artifact, so the brief was not finalized.",
        };
      }
      if (write.kind === "unavailable") {
        // The host never answered, so whether it wrote the deliverable is
        // unknown. Saying it was not written would be a guess.
        return {
          kind: "rejected",
          message:
            "The host did not confirm the report artifact, so the brief was not finalized. Check the Project for a report file before finalizing again.",
        };
      }
      drafts.current.set(input.briefId, write.artifact);

      const settle = async (
        outcome: WorkResearchMutationOutcome,
      ): Promise<WorkResearchMutationOutcome> => {
        if (outcome.kind === "accepted") {
          drafts.current.delete(input.briefId);
          return outcome;
        }
        const removed = await removeReportArtifact({
          mutationClient,
          projectId,
          artifact: write.artifact,
        });
        if (removed) drafts.current.delete(input.briefId);
        return {
          kind: "rejected",
          message: `${outcome.message} ${
            removed
              ? "The report artifact was removed, so no unreferenced report was left behind."
              : "The report artifact was written and could not be removed, so it remains in the Project; finalizing again updates it instead of writing a second report."
          }`,
        };
      };

      let command: WorkResearchCommand;
      try {
        command = decodeWorkResearchCommand({
          kind: "finalize-report",
          requestId: globalThis.crypto.randomUUID(),
          projectId,
          briefId: input.briefId,
          expectedVersion: view.brief.version,
          reportId: globalThis.crypto.randomUUID(),
          producedArtifactRef: write.artifact.artifactRef,
        });
      } catch {
        return await settle({ kind: "rejected", message: "This brief cannot be finalized." });
      }
      return await settle(await propose(command));
    },
    [options.enabled, options.mutationClient, options.projectId, propose, resolveBrief],
  );

  return {
    briefs,
    status,
    reload,
    createBrief,
    addSource,
    revokeSource,
    recordEvidence,
    recordClaim,
    finalizeReport,
  };
}
