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
  const githubInput = input.github;
  const linearInput = input.linear;

  return {
    ...(githubInput === undefined
      ? {}
      : {
          github: {
            available: githubInput.available,
            readIssue: async ({
              owner,
              name,
              number,
            }: {
              readonly owner: string;
              readonly name: string;
              readonly number: number;
            }) => {
              const response = await githubInput.client.readCatalogue({
                kind: "issue",
                owner,
                name,
                number,
              });
              if (response.kind === "unavailable") {
                return {
                  kind: "unavailable" as const,
                  reason: githubUnavailableReason(response.reason),
                  ...(response.remediation === undefined
                    ? {}
                    : { remediation: response.remediation }),
                  ...(response.retryAfterSeconds === undefined
                    ? {}
                    : { retryAfterSeconds: response.retryAfterSeconds }),
                };
              }
              if (response.kind !== "issue") {
                return { kind: "unavailable" as const, reason: "unavailable" as const };
              }
              return {
                kind: "resolved" as const,
                title: response.issue.title,
                url: response.issue.url,
                state: response.issue.state,
              };
            },
          },
        }),
    ...(linearInput === undefined
      ? {}
      : {
          linear: {
            available: linearInput.available,
            getIssue: async (key: string) => {
              try {
                const detail = await linearInput.client.getIssue({ id: key });
                return {
                  kind: "resolved" as const,
                  title: detail.title,
                  url: detail.url,
                  state: linearStateToChipState(detail.state.type),
                };
              } catch (error) {
                if (error instanceof IntegrationClientFailure) {
                  return linearFailureToLookup(error.message);
                }
                return { kind: "unavailable" as const, reason: "unavailable" as const };
              }
            },
          },
        }),
  };
}
