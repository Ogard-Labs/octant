import type { IntegrationHostPort } from "@octant/plugin-api/integration";
import type { IntegrationExecutionResult } from "@octant/contracts/integration";
import { isRecord, linearGraphql, readName } from "./linearGraphql";

export const LINEAR_ASSIGNMENT_SOURCE_OPERATION = "linear.assignment-source";
const QUERY = `query RoutineAssignments($after: String, $filter: IssueFilter!) {
  viewer { id name organization { id name } }
  issues(first: 100, after: $after, filter: $filter, orderBy: updatedAt) {
    pageInfo { hasNextPage endCursor }
    nodes { id identifier title url updatedAt }
  }
}`;

/** A complete current assignment set, through the plugin's declared credential/network port. */
export async function executeLinearAssignmentSource(
  host: IntegrationHostPort,
  input: unknown,
  signal?: AbortSignal,
): Promise<IntegrationExecutionResult> {
  if (
    !isRecord(input) ||
    Object.keys(input).some((key) => !["team", "project"].includes(key)) ||
    Object.values(input).some((value) => typeof value !== "string" || value.length > 128)
  )
    return { kind: "refused", reason: "The assignment source filters are invalid." };
  const team = typeof input.team === "string" ? input.team.trim() : "";
  const project = typeof input.project === "string" ? input.project.trim() : "";
  if (
    (team !== "" && !/^[A-Za-z][A-Za-z0-9_-]{0,19}$/.test(team)) ||
    (project !== "" && !/^[A-Za-z0-9_-]{1,128}$/.test(project))
  )
    return { kind: "refused", reason: "Choose a valid team key and project identifier." };
  const filter = {
    assignee: { isMe: { eq: true } },
    ...(team === "" ? {} : { team: { key: { eqIgnoreCase: team } } }),
    ...(project === "" ? {} : { project: { id: { eq: project } } }),
  };
  const events: Array<{
    readonly id: string;
    readonly label: string;
    readonly occurredAt: string;
    readonly url: string;
    readonly data: string;
    readonly routineOutput: boolean;
  }> = [];
  let cursor: string | undefined;
  let identity: string | undefined;
  let label: string | undefined;
  for (let page = 0; page < 3; page += 1) {
    if (signal?.aborted)
      return {
        kind: "failed",
        reason: "The assignment observation was cancelled.",
        retryable: true,
      };
    const result = await linearGraphql(
      host,
      QUERY,
      { filter, ...(cursor === undefined ? {} : { after: cursor }) },
      signal,
    );
    if (result.kind !== "ok")
      return {
        kind: "failed",
        reason:
          result.kind === "rate-limited"
            ? "Linear is rate limited."
            : "The assignment source is unavailable.",
        retryable: true,
      };
    const body = result.body;
    if (
      !isRecord(body) ||
      !isRecord(body.data) ||
      !isRecord(body.data.viewer) ||
      !isRecord(body.data.viewer.organization) ||
      !isRecord(body.data.issues) ||
      !Array.isArray(body.data.issues.nodes) ||
      !isRecord(body.data.issues.pageInfo)
    )
      return {
        kind: "failed",
        reason: "The assignment observation is incomplete.",
        retryable: true,
      };
    const viewer = readName(body.data.viewer.id, 128);
    const organization = readName(body.data.viewer.organization.id, 128);
    if (viewer === undefined || organization === undefined)
      return { kind: "failed", reason: "The assignment account is unavailable.", retryable: true };
    const observed = JSON.stringify([viewer, organization]);
    if (identity !== undefined && identity !== observed)
      return { kind: "refused", reason: "The assignment account changed." };
    identity = observed;
    label =
      `Issues assigned to ${readName(body.data.viewer.name, 128) ?? "me"} in ${readName(body.data.viewer.organization.name, 128) ?? "Linear"}`.slice(
        0,
        256,
      );
    for (const node of body.data.issues.nodes) {
      if (
        !isRecord(node) ||
        typeof node.id !== "string" ||
        !/^[A-Za-z0-9_-]{1,128}$/.test(node.id) ||
        typeof node.identifier !== "string" ||
        !/^[A-Z][A-Z0-9]{0,9}-\d{1,9}$/.test(node.identifier) ||
        typeof node.title !== "string" ||
        typeof node.updatedAt !== "string" ||
        typeof node.url !== "string" ||
        !/^https:\/\/linear\.app\/[A-Za-z0-9_.\-/]*$/.test(node.url)
      )
        return {
          kind: "failed",
          reason: "The assignment observation is incomplete.",
          retryable: true,
        };
      events.push({
        id: node.id,
        label: `${node.identifier}: ${node.title}`.slice(0, 256),
        occurredAt: node.updatedAt,
        url: node.url,
        data: JSON.stringify({ identifier: node.identifier, title: node.title.slice(0, 256) }),
        routineOutput: false,
      });
    }
    if (events.length > 256)
      return {
        kind: "refused",
        reason: "The assignment source exceeds 256 issues. Narrow its filters.",
      };
    const info = body.data.issues.pageInfo;
    if (info.hasNextPage === false) return { kind: "ok", value: { identity, label, events } };
    if (
      info.hasNextPage !== true ||
      typeof info.endCursor !== "string" ||
      !/^[A-Za-z0-9+/=_-]{1,600}$/.test(info.endCursor) ||
      info.endCursor === cursor
    )
      return {
        kind: "failed",
        reason: "The assignment observation is incomplete.",
        retryable: true,
      };
    cursor = info.endCursor;
  }
  return {
    kind: "refused",
    reason: "The assignment source exceeds its page limit. Narrow its filters.",
  };
}
