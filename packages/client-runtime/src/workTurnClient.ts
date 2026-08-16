import {
  decodeCancelWorkTurnCommand,
  decodeWorkThreadTranscript,
  decodeWorkTurnCancelResult,
  decodeWorkTurnLookupResult,
  decodeWorkTurnRequestId,
  decodeStartWorkThreadTurnCommand,
  type CancelWorkTurnCommand,
  type WorkThreadId,
  type WorkThreadTranscript,
  type WorkTurnCancelResult,
  type WorkTurnLookupResult,
  type WorkTurnRequestId,
  type StartWorkThreadTurnCommand,
} from "@octant/contracts";
import { bindFetchPort } from "./bindFetchPort";

export interface WorkTurnClientOptions {
  readonly baseUrl: string;
  readonly fetch: typeof globalThis.fetch;
  readonly windowCapability: string;
}

export interface WorkTurnClient {
  startFirstTurn(command: StartWorkThreadTurnCommand): Promise<WorkTurnLookupResult>;
  lookupFirstTurn(requestId: WorkTurnRequestId): Promise<WorkTurnLookupResult>;
  cancelFirstTurn(command: CancelWorkTurnCommand): Promise<WorkTurnCancelResult>;
  transcript(threadId: WorkThreadId): Promise<WorkThreadTranscript>;
}

export class WorkTurnClientFailure extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "WorkTurnClientFailure";
    this.status = status;
  }
}

export function createWorkTurnClient(options: WorkTurnClientOptions): WorkTurnClient {
  validateLoopbackBaseUrl(options.baseUrl);
  const fetch = bindFetchPort(options.fetch);
  return {
    async startFirstTurn(command) {
      let validated: StartWorkThreadTurnCommand;
      try {
        validated = decodeStartWorkThreadTurnCommand(command);
      } catch {
        throw new WorkTurnClientFailure("Work turn command is invalid.", 0);
      }
      return postJson(
        fetch,
        options,
        "/api/work/turns",
        validated,
        decodeWorkTurnLookupResult,
        "Work turn start failed.",
      );
    },
    async lookupFirstTurn(requestId) {
      let validated: WorkTurnRequestId;
      try {
        validated = decodeWorkTurnRequestId(requestId);
      } catch {
        throw new WorkTurnClientFailure("Work turn request id is invalid.", 0);
      }
      return getJson(
        fetch,
        options,
        `/api/work/turns/${validated}`,
        decodeWorkTurnLookupResult,
        "Work turn lookup failed.",
      );
    },
    async cancelFirstTurn(command) {
      let validated: CancelWorkTurnCommand;
      try {
        validated = decodeCancelWorkTurnCommand(command);
      } catch {
        throw new WorkTurnClientFailure("Work turn cancel command is invalid.", 0);
      }
      return postJson(
        fetch,
        options,
        "/api/work/turns/cancel",
        validated,
        decodeWorkTurnCancelResult,
        "Work turn cancel failed.",
      );
    },
    async transcript(threadId) {
      return getJson(
        fetch,
        options,
        `/api/work/turns/transcript/${threadId}`,
        decodeWorkThreadTranscript,
        "Work transcript lookup failed.",
      );
    },
  };
}

async function postJson<T>(
  fetch: typeof globalThis.fetch,
  options: WorkTurnClientOptions,
  path: string,
  body: unknown,
  decode: (value: unknown) => T,
  failureMessage: string,
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(new URL(path, options.baseUrl).toString(), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-octant-window-capability": options.windowCapability,
      },
      body: JSON.stringify(body),
    });
  } catch {
    throw new WorkTurnClientFailure("Work turn service is unavailable.", 0);
  }
  const payload: unknown = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new WorkTurnClientFailure(responseMessage(payload, failureMessage), response.status);
  }
  try {
    return decode(payload);
  } catch {
    throw new WorkTurnClientFailure("Work turn service returned an invalid response.", 0);
  }
}

async function getJson<T>(
  fetch: typeof globalThis.fetch,
  options: WorkTurnClientOptions,
  path: string,
  decode: (value: unknown) => T,
  failureMessage: string,
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(new URL(path, options.baseUrl).toString(), {
      method: "GET",
      headers: { "x-octant-window-capability": options.windowCapability },
    });
  } catch {
    throw new WorkTurnClientFailure("Work turn service is unavailable.", 0);
  }
  const payload: unknown = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new WorkTurnClientFailure(responseMessage(payload, failureMessage), response.status);
  }
  try {
    return decode(payload);
  } catch {
    throw new WorkTurnClientFailure("Work turn service returned an invalid response.", 0);
  }
}

function responseMessage(body: unknown, fallback: string): string {
  return typeof body === "object" &&
    body !== null &&
    "message" in body &&
    typeof body.message === "string"
    ? body.message
    : fallback;
}

function validateLoopbackBaseUrl(baseUrl: string): void {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new WorkTurnClientFailure("Work turn base URL is invalid.", 0);
  }
  if (url.hostname !== "127.0.0.1" && url.hostname !== "localhost" && url.hostname !== "::1") {
    throw new WorkTurnClientFailure("Work turn base URL must be loopback.", 0);
  }
}
