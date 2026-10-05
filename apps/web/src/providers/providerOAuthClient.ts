import type { ProviderOAuthCommand, ProviderOAuthCommandResult } from "./ProviderOAuthSignIn";

const TOKEN_FIELDS = [
  "accessToken",
  "refreshToken",
  "access_token",
  "refresh_token",
  "codeVerifier",
];

export async function runProviderOAuthCommand(options: {
  readonly baseUrl: string;
  readonly windowCapability: string;
  readonly fetch?: typeof fetch;
  readonly command: ProviderOAuthCommand;
}): Promise<ProviderOAuthCommandResult | undefined> {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const response = await fetchImpl(new URL("/api/providers/oauth", options.baseUrl), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-octant-window-capability": options.windowCapability,
    },
    body: JSON.stringify(options.command),
  });
  const body: unknown = await response.json();
  if (!response.ok || !isRecord(body) || typeof body.kind !== "string") return undefined;
  if (TOKEN_FIELDS.some((field) => field in body)) return undefined;
  return {
    kind: body.kind as ProviderOAuthCommandResult["kind"],
    ...(typeof body.termsRequired === "boolean" ? { termsRequired: body.termsRequired } : {}),
    ...(typeof body.accountLabel === "string" ? { accountLabel: body.accountLabel } : {}),
    ...(typeof body.authorizationUrl === "string"
      ? { authorizationUrl: body.authorizationUrl }
      : {}),
    ...(typeof body.userCode === "string" ? { userCode: body.userCode } : {}),
    ...(typeof body.verificationUri === "string" ? { verificationUri: body.verificationUri } : {}),
    ...(typeof body.reason === "string" ? { reason: body.reason } : {}),
    ...(typeof body.attemptId === "string" ? { attemptId: body.attemptId } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
