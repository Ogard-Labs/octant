import {
  type GithubSearchRow,
  type LinearIssueRow,
  type MentionableThreadId,
  type ProjectId,
  type WindowId,
} from "@octant/contracts";
import {
  decodeTrackerMentionCandidate,
  MAX_TRACKER_MENTION_CANDIDATES,
  type TrackerMentionCandidate,
  type TrackerMentionSearchRequest,
} from "@octant/contracts/tracker-mention-search";
import { parseTrackerMentionQuery } from "@octant/domain/tracker-mention-policy";

/** The rows one tracker contributes, so a busy one cannot crowd out the other. */
const MAX_ROWS_PER_TRACKER = MAX_TRACKER_MENTION_CANDIDATES / 2;
const SEARCH_TIMEOUT_MS = 8_000;

export interface TrackerMentionRepository {
  readonly owner: string;
  readonly name: string;
}

/** Where a composer's Project keeps its pull requests and issues. */
export interface TrackerMentionProject {
  readonly repository?: TrackerMentionRepository | undefined;
  readonly linearTeamId?: string | undefined;
}

export interface TrackerMentionSearchSources {
  /**
   * The Project of a thread this window can open; an empty answer for one in no
   * Project, and `undefined` for a thread the window cannot open.
   */
  readonly threadProject: (
    windowId: WindowId,
    threadId: MentionableThreadId,
  ) => Promise<{ readonly projectId?: string | undefined } | undefined>;
  /** `undefined` for a Project this window does not hold. */
  readonly windowProject: (
    windowId: WindowId,
    projectId: ProjectId | string,
  ) => Promise<TrackerMentionProject | undefined>;
  readonly github: {
    /** Whether the host's GitHub integration is on; it never asks to connect one. */
    readonly connected: () => boolean;
    readonly search: (
      input: TrackerMentionRepository & { readonly text: string },
      signal: AbortSignal,
    ) => Promise<ReadonlyArray<GithubSearchRow>>;
    readonly item: (
      input: TrackerMentionRepository & { readonly number: number },
      signal: AbortSignal,
    ) => Promise<GithubSearchRow | undefined>;
  };
  readonly linear: {
    /** Whether Linear is on and a connection is stored, answered without reaching Linear. */
    readonly connected: () => boolean;
    /** A key is asked for as itself; other text is matched against titles. */
    readonly list: (
      input: ({ readonly identifier: string } | { readonly search: string }) & {
        readonly teamId?: string;
      },
      signal: AbortSignal,
    ) => Promise<ReadonlyArray<LinearIssueRow>>;
  };
}

export type TrackerMentionSearch = (
  request: TrackerMentionSearchRequest,
  context: {
    readonly windowId: WindowId;
    /** Aborted when whoever asked no longer wants the rows. */
    readonly signal?: AbortSignal;
  },
) => Promise<ReadonlyArray<TrackerMentionCandidate>>;

/**
 * The pull requests and issues the `#` list offers. It is the person's own
 * search through connections the host already holds, scoped to the composer's
 * Project: nothing it returns is read for, or granted to, an agent. Every
 * refusal and every tracker failure is simply no rows, so the list never asks
 * anyone to connect anything.
 */
export function createTrackerMentionSearch(
  sources: TrackerMentionSearchSources,
): TrackerMentionSearch {
  async function scopeOf(
    request: TrackerMentionSearchRequest,
    windowId: WindowId,
  ): Promise<TrackerMentionProject | undefined> {
    let projectId: string | undefined = request.projectId;
    if (request.readerThreadId !== undefined) {
      // The thread decides its Project; a Project named beside it is not believed.
      const thread = await sources.threadProject(windowId, request.readerThreadId);
      if (thread === undefined) return undefined;
      projectId = thread.projectId;
    }
    return projectId === undefined ? {} : await sources.windowProject(windowId, projectId);
  }

  return async (request, { windowId, signal: abandoned }) => {
    const query = parseTrackerMentionQuery(request.query);
    if (query === undefined) return [];
    const githubConnected = query.kind !== "key" && sources.github.connected();
    const linearConnected = query.kind !== "number" && sources.linear.connected();
    if (!githubConnected && !linearConnected) return [];
    const project = await scopeOf(request, windowId);
    if (project === undefined || abandoned?.aborted === true) return [];
    const timeout = AbortSignal.timeout(SEARCH_TIMEOUT_MS);
    const signal = abandoned === undefined ? timeout : AbortSignal.any([abandoned, timeout]);

    const fromGithub = async () => {
      const repository = project.repository;
      if (!githubConnected || repository === undefined) return [];
      const rows =
        query.kind === "number"
          ? [await sources.github.item({ ...repository, number: query.number }, signal)]
          : await sources.github.search({ ...repository, text: query.text }, signal);
      return rows.flatMap((row) =>
        row === undefined
          ? []
          : shown({
              kind: row.kind === "pull-request" ? "pull-request" : "github-issue",
              source: "github",
              id: String(row.number),
              url: row.url,
              title: row.title,
              state: row.state,
              container: `${repository.owner}/${repository.name}`,
              person: row.author,
            }),
      );
    };
    const fromLinear = async () => {
      if (!linearConnected) return [];
      const rows = await sources.linear.list(
        {
          ...(query.kind === "key" ? { identifier: query.key } : { search: query.text }),
          ...(project.linearTeamId === undefined ? {} : { teamId: project.linearTeamId }),
        },
        signal,
      );
      return rows.flatMap((row) =>
        shown({
          kind: "linear-issue",
          source: "linear",
          id: row.identifier,
          url: row.url,
          title: row.title,
          state: row.state.name,
          container: row.teamKey ?? row.identifier.slice(0, row.identifier.lastIndexOf("-")),
          ...(row.assignee === undefined ? {} : { person: row.assignee }),
        }),
      );
    };
    const found = await Promise.all(
      [fromGithub, fromLinear].map(async (read) => {
        try {
          return (await read()).slice(0, MAX_ROWS_PER_TRACKER);
        } catch {
          return [];
        }
      }),
    );
    return found.flat();
  };
}

/** A row whose facts the list cannot carry honestly is left out. */
function shown(candidate: unknown): ReadonlyArray<TrackerMentionCandidate> {
  try {
    return [decodeTrackerMentionCandidate(candidate)];
  } catch {
    return [];
  }
}
