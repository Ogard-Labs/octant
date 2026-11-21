import type {
  IntegrationActivityAccount,
  IntegrationActivityCard,
  IntegrationActivitySource,
  IntegrationHostPort,
} from "@octant/plugin-api/integration";
import type { GithubAuthenticationSnapshot, GithubCapabilityKind } from "@octant/contracts";
import { decideGithubCatalogueRead } from "@octant/domain";
import { decodeActivityRecord, type ActivityRecord } from "@octant/contracts/code-home-activity";
import type { GhHomeActivityPort, GhHomeActivityRow } from "../../github/ghHomeActivityPort";

type ActivityDelivery = Exclude<ActivityRecord, { kind: "runs" }>;

/** The catalogue capability each card's read actually needs. */
const capabilityOf = (card: IntegrationActivityCard): GithubCapabilityKind =>
  card === "prs-merged"
    ? "pull-requests-read"
    : card === "issues-closed"
      ? "issues-read"
      : "repository-catalogue";

/**
 * The bundled GitHub integration's Code Home activity contribution. The
 * source is read-only: it reports the connection `gh` would run under and
 * answers one repository and range at a time with the signed-in person's own
 * validated delivery records. It observes nothing while the integration is
 * ineffective, and rechecks effectiveness after every await so rows gathered
 * before a mid-read disable never leave the source.
 */
export function contributeGithubActivity(
  host: Pick<IntegrationHostPort, "registerActivitySource">,
  ports: {
    readonly capabilitySnapshot: (signal: AbortSignal) => Promise<GithubAuthenticationSnapshot>;
    readonly effective: () => boolean;
    readonly observe: Pick<GhHomeActivityPort, "observe">["observe"] | undefined;
  },
) {
  const account = async (
    card: IntegrationActivityCard,
    signal: AbortSignal,
  ): Promise<IntegrationActivityAccount> => {
    // The switch precedes every credential observation.
    if (!ports.effective() || signal.aborted) {
      return { status: "unavailable", reason: "not-connected" };
    }
    let snapshot: GithubAuthenticationSnapshot;
    try {
      snapshot = await ports.capabilitySnapshot(signal);
    } catch {
      return { status: "unavailable", reason: "read-failed" };
    }
    if (!ports.effective() || signal.aborted) {
      return { status: "unavailable", reason: "not-connected" };
    }
    // A disconnected or insecure account is a labeled non-connection; a live
    // account that cannot be observed is a read failure, never a connection
    // claim.
    if (snapshot.state === "insecure-storage" || snapshot.state === "external-token") {
      return { status: "insecure-storage" };
    }
    if (snapshot.state === "unauthorized") return { status: "disconnected" };
    if (snapshot.state === "unavailable") return { status: "unavailable", reason: "read-failed" };
    if (snapshot.state === "rate-limited") {
      return { status: "unavailable", reason: "rate-limited" };
    }
    const read = decideGithubCatalogueRead({
      capability: capabilityOf(card),
      snapshot: { state: snapshot.state, capabilities: snapshot.capabilities },
    });
    if (read.decision === "deny") {
      return {
        status: "unavailable",
        reason: read.reason === "rate-limited" ? "rate-limited" : "not-connected",
      };
    }
    const login = snapshot.account?.login.toLowerCase();
    if (login === undefined) return { status: "unavailable", reason: "not-connected" };
    return { status: "connected", account: login };
  };

  const readRepository: IntegrationActivitySource["readRepository"] = async (input) => {
    if (!ports.effective() || input.signal.aborted) {
      return { status: "unavailable", reason: "not-connected" };
    }
    if (ports.observe === undefined) return { status: "unavailable", reason: "not-checked" };
    const result = await ports.observe({
      owner: input.owner,
      name: input.name,
      card: input.card,
      since: input.since,
      until: input.until,
      signal: input.signal,
    });
    // Rows gathered before a mid-read disable or abort never leave the source.
    if (!ports.effective() || input.signal.aborted) {
      return { status: "unavailable", reason: "read-failed" };
    }
    if (result.status === "unavailable") {
      return { status: "unavailable", reason: result.reason };
    }
    // A repository the account can no longer reach is access loss, whatever
    // rows the adapter happened to gather beside the reason.
    if (result.status === "partial" && result.reason === "repository-missing") {
      return { status: "repository-missing" };
    }
    const records: ActivityDelivery[] = [];
    const repositoryKey = `${input.owner.toLowerCase()}/${input.name.toLowerCase()}`;
    for (const row of result.rows) {
      // Only the signed-in person's own actions are their activity: an
      // observation by or about any other actor is not counted.
      const actor =
        row.kind === "prs-merged"
          ? row.mergedBy
          : row.kind === "issues-closed"
            ? row.closedBy
            : row.publishedBy;
      if (actor.toLowerCase() !== input.account) continue;
      const record = forgeRecordOf(row, repositoryKey);
      if (record !== undefined) records.push(record);
    }
    if (result.status === "ready") return { status: "ready", records };
    return {
      status: "partial",
      reason: result.reason === "incomplete" ? "incomplete" : "read-failed",
      records,
    };
  };

  return host.registerActivitySource?.({ account, readRepository });
}

/**
 * Normalizes one observed forge row into a validated activity record; the
 * identity matches the journal's own `owner/name#number` form so the same
 * delivery cannot count twice across sources. Releases key on their stable
 * numeric release id, not the mutable tag.
 */
function forgeRecordOf(
  row: GhHomeActivityRow,
  repositoryKey: string,
): ActivityDelivery | undefined {
  const [repositoryOwner, repositoryName] = repositoryKey.split("/");
  if (repositoryOwner === undefined || repositoryName === undefined) return undefined;
  // GitHub omits fractional seconds; the contract's timestamp form needs them.
  const instant = (value: string): string => new Date(value).toISOString();
  // Runs are journal-local; a forged row is always a delivery record.
  const deliver = (value: unknown): ActivityDelivery | undefined => {
    const record = decodeActivityRecord(value);
    return record.kind === "runs" ? undefined : record;
  };
  try {
    if (row.kind === "prs-merged") {
      return deliver({
        kind: "prs-merged",
        occurredAt: instant(row.mergedAt),
        id: `${repositoryKey}#${row.number}`,
        label: row.title === "" ? `${repositoryKey}#${row.number}` : row.title,
        repositoryOwner,
        repositoryName,
        number: row.number,
        mergedBy: row.mergedBy,
      });
    }
    if (row.kind === "issues-closed") {
      return deliver({
        kind: "issues-closed",
        occurredAt: instant(row.closedAt),
        id: `${repositoryKey}#${row.number}`,
        label: row.title === "" ? `${repositoryKey}#${row.number}` : row.title,
        repositoryOwner,
        repositoryName,
        number: row.number,
      });
    }
    if (!isCanonicalReleaseHref(row.url, repositoryKey)) return undefined;
    return deliver({
      kind: "releases-published",
      occurredAt: instant(row.publishedAt),
      id: `${repositoryKey}/releases/${row.releaseId}`,
      label: row.name === "" ? row.tag : row.name,
      tag: row.tag,
      url: row.url,
    });
  } catch {
    return undefined;
  }
}

/**
 * A release link is trusted only when it is a canonical github.com release
 * tag URL for the authorized repository: exact https host, no credentials,
 * and an `/{owner}/{repo}/releases/tag/…` path. Anything else — an
 * attacker-influenced or third-party URL — is dropped, never shown.
 */
function isCanonicalReleaseHref(url: string, repositoryKey: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.hostname !== "github.com" ||
    parsed.username !== "" ||
    parsed.password !== ""
  ) {
    return false;
  }
  const prefix = `/${repositoryKey}/releases/tag/`;
  const path = parsed.pathname.toLowerCase();
  return path.startsWith(prefix) && path.length > prefix.length;
}
