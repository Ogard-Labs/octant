// The App Store Connect API calls a person-confirmed submission or release
// makes (docs/design/apple-devices.md § Distribution). Every request goes to
// the one API host the architecture records for it, carries a token the
// credential broker signed for it, and never follows a redirect. The token is
// used for one step's requests and dropped; nothing here logs it.

const API_ORIGIN = "https://api.appstoreconnect.apple.com";
const REQUEST_TIMEOUT_MS = 60_000;
const MAX_REASON_LENGTH = 1_024;
const ID = /^[A-Za-z0-9-]{1,128}$/;
const STATE = /^[A-Z_]{1,64}$/;

/** The version App Store Connect holds for one app, as it answered. */
export interface AppStoreConnectVersion {
  readonly appId: string;
  readonly versionId: string;
  /** App Store Connect's own name for the version's state, such as `PREPARE_FOR_SUBMISSION`. */
  readonly state: string;
  /** The build selected for the version, when one is. */
  readonly build?: {
    readonly buildNumber: string;
    /** `VALID` once App Store Connect has finished processing it. */
    readonly processingState: string;
  };
}

export type AppStoreConnectVersionRead =
  | { readonly kind: "found"; readonly version: AppStoreConnectVersion }
  | { readonly kind: "no-app" }
  | { readonly kind: "no-version" }
  /** App Store Connect answered with an error; its own reason, as given. */
  | { readonly kind: "refused"; readonly reason: string }
  | { readonly kind: "unclassified" };

export type AppStoreConnectStep =
  /** App Store Connect took the step; its identifier for the submission or release request. */
  | { readonly kind: "done"; readonly id: string }
  | { readonly kind: "refused"; readonly reason: string }
  | { readonly kind: "unclassified" };

/**
 * The few App Store Connect API calls Octant makes. A stub stands in for it in
 * every test; nothing in the test suite reaches App Store Connect.
 */
export interface AppStoreConnectApi {
  readonly readVersion: (
    token: string,
    input: { readonly bundleIdentifier: string; readonly version: string },
    signal?: AbortSignal,
  ) => Promise<AppStoreConnectVersionRead>;
  /** Submits that one version for App Review, as one review submission. */
  readonly submitForReview: (
    token: string,
    input: { readonly appId: string; readonly versionId: string },
    signal?: AbortSignal,
  ) => Promise<AppStoreConnectStep>;
  /** Releases that one version, approved and waiting for a manual release. */
  readonly release: (
    token: string,
    input: { readonly versionId: string },
    signal?: AbortSignal,
  ) => Promise<AppStoreConnectStep>;
}

type Answer =
  | { readonly kind: "ok"; readonly body: unknown }
  | { readonly kind: "refused"; readonly reason: string }
  | { readonly kind: "unclassified" };

/** The one network call the client makes; a stub stands in for it in tests. */
export type AppStoreConnectFetch = (url: string, init: RequestInit) => Promise<Response>;

export function createAppStoreConnectApi(
  fetch: AppStoreConnectFetch = globalThis.fetch,
): AppStoreConnectApi {
  const call = async (
    token: string,
    method: "GET" | "POST" | "PATCH",
    path: string,
    body: unknown,
    signal: AbortSignal | undefined,
  ): Promise<Answer> => {
    let response: Response;
    try {
      response = await fetch(new URL(path, API_ORIGIN).toString(), {
        method,
        redirect: "error",
        headers: {
          authorization: `Bearer ${token}`,
          accept: "application/json",
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal:
          signal === undefined
            ? AbortSignal.timeout(REQUEST_TIMEOUT_MS)
            : AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
      });
    } catch {
      return { kind: "unclassified" };
    }
    let parsed: unknown;
    try {
      parsed = response.status === 204 ? {} : await response.json();
    } catch {
      return { kind: "unclassified" };
    }
    if (response.ok) return { kind: "ok", body: parsed };
    const reason = errorReason(parsed);
    return reason === undefined ? { kind: "unclassified" } : { kind: "refused", reason };
  };

  const api: AppStoreConnectApi = {
    readVersion: async (token, input, signal) => {
      const apps = await call(
        token,
        "GET",
        `/v1/apps?filter[bundleId]=${encodeURIComponent(input.bundleIdentifier)}&fields[apps]=bundleId&limit=2`,
        undefined,
        signal,
      );
      if (apps.kind !== "ok") return apps;
      const app = dataArray(apps.body).find(
        (entry) => attribute(entry, "bundleId") === input.bundleIdentifier,
      );
      const appId = app === undefined ? undefined : resourceId(app);
      if (appId === undefined) return { kind: "no-app" };
      const versions = await call(
        token,
        "GET",
        `/v1/apps/${appId}/appStoreVersions?filter[platform]=IOS&filter[versionString]=${encodeURIComponent(input.version)}&include=build&limit=2`,
        undefined,
        signal,
      );
      if (versions.kind !== "ok") return versions;
      const matching = dataArray(versions.body).filter(
        (entry) => attribute(entry, "versionString") === input.version,
      );
      const [entry] = matching;
      const versionId = entry === undefined ? undefined : resourceId(entry);
      if (entry === undefined || versionId === undefined || matching.length !== 1) {
        return { kind: "no-version" };
      }
      // The newer `appVersionState` replaces `appStoreState`; either names the state.
      const state = attribute(entry, "appVersionState") ?? attribute(entry, "appStoreState");
      if (state === undefined || !STATE.test(state)) return { kind: "unclassified" };
      const build = selectedBuild(entry, versions.body);
      return {
        kind: "found",
        version: { appId, versionId, state, ...(build === undefined ? {} : { build }) },
      };
    },

    submitForReview: async (token, input, signal) => {
      const created = await call(
        token,
        "POST",
        "/v1/reviewSubmissions",
        {
          data: {
            type: "reviewSubmissions",
            attributes: { platform: "IOS" },
            relationships: { app: { data: { type: "apps", id: input.appId } } },
          },
        },
        signal,
      );
      if (created.kind !== "ok") return created;
      const submissionId = resourceId(dataObject(created.body));
      if (submissionId === undefined) return { kind: "unclassified" };
      const item = await call(
        token,
        "POST",
        "/v1/reviewSubmissionItems",
        {
          data: {
            type: "reviewSubmissionItems",
            relationships: {
              reviewSubmission: { data: { type: "reviewSubmissions", id: submissionId } },
              appStoreVersion: { data: { type: "appStoreVersions", id: input.versionId } },
            },
          },
        },
        signal,
      );
      const submitted =
        item.kind === "ok"
          ? await call(
              token,
              "PATCH",
              `/v1/reviewSubmissions/${submissionId}`,
              {
                data: {
                  type: "reviewSubmissions",
                  id: submissionId,
                  attributes: { submitted: true },
                },
              },
              signal,
            )
          : item;
      if (submitted.kind === "ok") return { kind: "done", id: submissionId };
      // The empty draft this left behind is withdrawn, so a refused submission
      // changes nothing in App Store Connect. That cleanup is not retried.
      await call(
        token,
        "PATCH",
        `/v1/reviewSubmissions/${submissionId}`,
        { data: { type: "reviewSubmissions", id: submissionId, attributes: { canceled: true } } },
        undefined,
      );
      return submitted;
    },

    release: async (token, input, signal) => {
      const requested = await call(
        token,
        "POST",
        "/v1/appStoreVersionReleaseRequests",
        {
          data: {
            type: "appStoreVersionReleaseRequests",
            relationships: {
              appStoreVersion: { data: { type: "appStoreVersions", id: input.versionId } },
            },
          },
        },
        signal,
      );
      if (requested.kind !== "ok") return requested;
      const id = resourceId(dataObject(requested.body));
      return id === undefined ? { kind: "unclassified" } : { kind: "done", id };
    },
  };
  return Object.freeze(api);
}

function selectedBuild(
  version: Readonly<Record<string, unknown>>,
  document: unknown,
): AppStoreConnectVersion["build"] {
  const relationships = record(version.relationships);
  const buildData = record(record(relationships?.build)?.data);
  const buildId = buildData === undefined ? undefined : resourceId(buildData);
  if (buildId === undefined) return undefined;
  const included = record(document)?.included;
  if (!Array.isArray(included)) return undefined;
  const build = included
    .map(record)
    .find((entry) => entry?.type === "builds" && resourceId(entry) === buildId);
  if (build === undefined) return undefined;
  const buildNumber = attribute(build, "version");
  const processingState = attribute(build, "processingState");
  if (buildNumber === undefined || processingState === undefined) return undefined;
  return { buildNumber, processingState };
}

/** App Store Connect's own words for a refusal: each error's detail, or its title. */
function errorReason(document: unknown): string | undefined {
  const errors = record(document)?.errors;
  if (!Array.isArray(errors)) return undefined;
  const reasons = errors
    .map(record)
    .map((error) => {
      const detail = error?.detail;
      const title = error?.title;
      return typeof detail === "string" ? detail : typeof title === "string" ? title : undefined;
    })
    .filter((reason): reason is string => reason !== undefined && reason.trim() !== "");
  if (reasons.length === 0) return undefined;
  return reasons.join(" ").slice(0, MAX_REASON_LENGTH);
}

function dataArray(document: unknown): ReadonlyArray<Readonly<Record<string, unknown>>> {
  const data = record(document)?.data;
  if (!Array.isArray(data)) return [];
  return data
    .map(record)
    .filter((entry): entry is Readonly<Record<string, unknown>> => entry !== undefined);
}

function dataObject(document: unknown): Readonly<Record<string, unknown>> {
  return record(record(document)?.data) ?? {};
}

function resourceId(resource: Readonly<Record<string, unknown>>): string | undefined {
  const id = resource.id;
  return typeof id === "string" && ID.test(id) ? id : undefined;
}

function attribute(resource: Readonly<Record<string, unknown>>, name: string): string | undefined {
  const value = record(resource.attributes)?.[name];
  return typeof value === "string" ? value : undefined;
}

function record(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}
