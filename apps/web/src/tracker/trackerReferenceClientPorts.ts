import type { GithubClient } from "@octant/client-runtime/github-client";
import {
  IntegrationClientFailure,
  type IntegrationClient,
} from "@octant/client-runtime/integration-client";
import type { TrackerReferenceResolvePorts } from "./trackerReferenceResolve";
import {
  githubUnavailableReason,
  linearFailureToLookup,
  linearStateToChipState,
} from "./trackerReferenceResolve";

export interface TrackerReferenceClientPortsInput {
  readonly github?: {
    readonly available: boolean;
    readonly client: GithubClient;
  };
  readonly linear?: {
    readonly available: boolean;
    readonly client: IntegrationClient;
  };
}

/**
 * Bind the App's existing GitHub and Linear clients into the narrow resolve
 * ports. Display fields only — body, comments, and credential material stay
 * on the catalogue / integration routes.
 */
export function createTrackerReferenceClientPorts(
  input: TrackerReferenceClientPortsInput,
): TrackerReferenceResolvePorts {
  const ports: {
    github?: TrackerReferenceResolvePorts["github"];
    linear?: TrackerReferenceResolvePorts["linear"];
  } = {};

  if (input.github !== undefined) {
    const { available, client } = input.github;
    ports.github = {
      available,
      readIssue: async ({ owner, name, number }) => {
        const response = await client.readCatalogue({
          kind: "issue",
          owner,
          name,
          number,
        });
        if (response.kind === "unavailable") {
          return {
            kind: "unavailable",
            reason: githubUnavailableReason(response.reason),
            ...(response.remediation === undefined ? {} : { remediation: response.remediation }),
            ...(response.retryAfterSeconds === undefined
              ? {}
              : { retryAfterSeconds: response.retryAfterSeconds }),
          };
        }
        if (response.kind !== "issue") {
          return { kind: "unavailable", reason: "unavailable" };
        }
        return {
          kind: "resolved",
          title: response.issue.title,
          url: response.issue.url,
          state: response.issue.state,
        };
      },
    };
  }

  if (input.linear !== undefined) {
    const { available, client } = input.linear;
    ports.linear = {
      available,
      getIssue: async (key) => {
        try {
          const detail = await client.getIssue({ id: key });
          return {
            kind: "resolved",
            title: detail.title,
            url: detail.url,
            state: linearStateToChipState(detail.state.type),
          };
        } catch (error) {
          if (error instanceof IntegrationClientFailure) {
            return linearFailureToLookup(error.message);
          }
          return { kind: "unavailable", reason: "unavailable" };
        }
      },
    };
  }

  return ports;
}
