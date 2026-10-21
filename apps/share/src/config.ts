import {
  CANVAS_PUBLIC_SHARE_MAX_DOCUMENT_BYTES,
  decodeCanvasPublicShareServiceUrl,
} from "@octant/contracts/canvas-public-share";

/** 5 GiB: past this the service answers `unavailable` to a create. */
export const SHARE_DEFAULT_MAX_TOTAL_BYTES = 5 * 1024 * 1024 * 1024;

export interface ShareConfig {
  readonly host: string;
  /** 0 asks the system for a free port; tests and the smoke use it. */
  readonly port: number;
  readonly usercontentPort: number;
  /**
   * Absent only when the matching port is 0, so the origin is not known until
   * the listener is bound; the service then derives it from the bound port.
   */
  readonly publicOrigin: string | undefined;
  readonly usercontentOrigin: string | undefined;
  readonly dataDir: string;
  readonly maxDocumentBytes: number;
  readonly maxTotalBytes: number;
  readonly abuseContact: string | undefined;
  /** Whether `X-Forwarded-For` names the client; only behind a proxy the operator controls. */
  readonly trustProxy: boolean;
  /**
   * The operator listener, always on 127.0.0.1 and only when a token is set.
   * Takedown runs inside the serving process through it, because a second
   * process writing the store races the server's own writes.
   */
  readonly operatorPort: number;
  readonly operatorToken: string | undefined;
}

/** At least 32 characters, so the operator token cannot be guessed. */
const MIN_OPERATOR_TOKEN_LENGTH = 32;

export type ShareConfigResult =
  | { readonly status: "ok"; readonly config: ShareConfig }
  | { readonly status: "refused"; readonly reason: string };

type Environment = Readonly<Record<string, string | undefined>>;

function integer(
  env: Environment,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number | undefined {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  if (!/^\d+$/.test(raw)) return undefined;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= minimum && value <= maximum ? value : undefined;
}

function origin(value: string): string | undefined {
  try {
    decodeCanvasPublicShareServiceUrl(value);
    const parsed = new URL(value);
    // A path would make the links the service hands out point somewhere it does not serve.
    return parsed.pathname === "/" && parsed.search === "" ? parsed.origin : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Reads the service's configuration. Anything unusable is a refusal rather
 * than a quiet default, because a service that starts with the wrong origins
 * would draw author markup on the origin that holds the viewer.
 */
export function readShareConfig(env: Environment): ShareConfigResult {
  const refuse = (reason: string): ShareConfigResult => ({ status: "refused", reason });
  const host = env["OCTANT_SHARE_HOST"] ?? "127.0.0.1";
  const port = integer(env, "OCTANT_SHARE_PORT", 4100, 0, 65_535);
  const usercontentPort = integer(env, "OCTANT_SHARE_USERCONTENT_PORT", 4101, 0, 65_535);
  const operatorPort = integer(env, "OCTANT_SHARE_OPERATOR_PORT", 4102, 0, 65_535);
  const operatorToken = env["OCTANT_SHARE_OPERATOR_TOKEN"];
  const maxDocumentBytes = integer(
    env,
    "OCTANT_SHARE_MAX_DOCUMENT_BYTES",
    CANVAS_PUBLIC_SHARE_MAX_DOCUMENT_BYTES,
    1,
    64 * 1024 * 1024,
  );
  const maxTotalBytes = integer(
    env,
    "OCTANT_SHARE_MAX_TOTAL_BYTES",
    SHARE_DEFAULT_MAX_TOTAL_BYTES,
    1,
    Number.MAX_SAFE_INTEGER,
  );
  if (port === undefined) return refuse("OCTANT_SHARE_PORT is not a port number.");
  if (usercontentPort === undefined) {
    return refuse("OCTANT_SHARE_USERCONTENT_PORT is not a port number.");
  }
  if (operatorPort === undefined) return refuse("OCTANT_SHARE_OPERATOR_PORT is not a port number.");
  if (
    operatorToken !== undefined &&
    operatorToken !== "" &&
    operatorToken.length < MIN_OPERATOR_TOKEN_LENGTH
  ) {
    return refuse(
      `OCTANT_SHARE_OPERATOR_TOKEN must be at least ${String(MIN_OPERATOR_TOKEN_LENGTH)} characters.`,
    );
  }
  if (maxDocumentBytes === undefined) {
    return refuse("OCTANT_SHARE_MAX_DOCUMENT_BYTES is not a usable byte count.");
  }
  if (maxTotalBytes === undefined) {
    return refuse("OCTANT_SHARE_MAX_TOTAL_BYTES is not a usable byte count.");
  }
  const dataDir = env["OCTANT_SHARE_DATA_DIR"];
  if (dataDir === undefined || dataDir === "") return refuse("OCTANT_SHARE_DATA_DIR is required.");

  const resolveOrigin = (
    explicit: string | undefined,
    boundPort: number,
  ): { readonly value: string | undefined } | undefined => {
    if (explicit !== undefined && explicit !== "") {
      const parsed = origin(explicit);
      return parsed === undefined ? undefined : { value: parsed };
    }
    return { value: boundPort === 0 ? undefined : `http://${host}:${String(boundPort)}` };
  };
  const publicOrigin = resolveOrigin(env["OCTANT_SHARE_PUBLIC_ORIGIN"], port);
  if (publicOrigin === undefined) {
    return refuse(
      "OCTANT_SHARE_PUBLIC_ORIGIN must be an https origin, or http on a loopback address.",
    );
  }
  const usercontentOrigin = resolveOrigin(env["OCTANT_SHARE_USERCONTENT_ORIGIN"], usercontentPort);
  if (usercontentOrigin === undefined) {
    return refuse(
      "OCTANT_SHARE_USERCONTENT_ORIGIN must be an https origin, or http on a loopback address.",
    );
  }
  if (publicOrigin.value !== undefined && publicOrigin.value === usercontentOrigin.value) {
    return refuse("The public origin and the user-content origin must differ.");
  }
  const abuseContact = env["OCTANT_SHARE_ABUSE_CONTACT"];
  return {
    status: "ok",
    config: {
      host,
      port,
      usercontentPort,
      publicOrigin: publicOrigin.value,
      usercontentOrigin: usercontentOrigin.value,
      dataDir,
      maxDocumentBytes,
      maxTotalBytes,
      abuseContact: abuseContact === undefined || abuseContact === "" ? undefined : abuseContact,
      trustProxy: env["OCTANT_SHARE_TRUST_PROXY"] === "1",
      operatorPort,
      operatorToken:
        operatorToken === undefined || operatorToken === "" ? undefined : operatorToken,
    },
  };
}
