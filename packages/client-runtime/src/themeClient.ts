import {
  decodeThemeBootstrap,
  decodeThemeCommand,
  decodeThemeCommandResult,
  decodeThemeFailure,
  type ThemeBootstrap,
  type ThemeCommand,
  type ThemeCommandResult,
  type ThemeFailure,
} from "@octant/contracts/theme";
import { bindFetchPort } from "./bindFetchPort";

export interface ThemeClientOptions {
  readonly baseUrl: string;
  readonly fetch: typeof globalThis.fetch;
  readonly windowCapability: string;
}

export interface ThemeClient {
  bootstrap(): Promise<ThemeBootstrap>;
  execute(command: ThemeCommand): Promise<ThemeCommandResult>;
}

export class ThemeClientFailure extends Error {
  readonly category: ThemeFailure["category"];
  readonly expectedVersion?: Extract<ThemeFailure, { category: "conflict" }>["expectedVersion"];
  readonly actualVersion?: Extract<ThemeFailure, { category: "conflict" }>["actualVersion"];

  constructor(failure: ThemeFailure) {
    super(failure.message);
    this.name = "ThemeClientFailure";
    this.category = failure.category;
    if (failure.category === "conflict") {
      this.expectedVersion = failure.expectedVersion;
      this.actualVersion = failure.actualVersion;
    }
  }
}

export function createThemeClient(options: ThemeClientOptions): ThemeClient {
  const fetch = bindFetchPort(options.fetch);
  const headers = { "x-octant-window-capability": options.windowCapability };
  return {
    bootstrap() {
      return request(
        fetch,
        new URL("/api/theme/bootstrap", options.baseUrl).toString(),
        { method: "GET", headers },
        decodeThemeBootstrap,
      );
    },
    execute(command) {
      let validated: ThemeCommand;
      try {
        validated = decodeThemeCommand(command);
      } catch {
        throw new ThemeClientFailure({ category: "invalid", message: "Theme command is invalid." });
      }
      return request(
        fetch,
        new URL("/api/theme/commands", options.baseUrl).toString(),
        {
          method: "POST",
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify(validated),
        },
        decodeThemeCommandResult,
      );
    },
  };
}

async function request<T>(
  fetch: typeof globalThis.fetch,
  url: string,
  init: RequestInit,
  decodeSuccess: (input: unknown) => T,
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, init);
  } catch {
    throw unavailable();
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw unavailable();
  }
  if (!response.ok) {
    try {
      throw new ThemeClientFailure(decodeThemeFailure(body));
    } catch (error) {
      if (error instanceof ThemeClientFailure) throw error;
      throw unavailable();
    }
  }
  try {
    return decodeSuccess(body);
  } catch {
    throw unavailable();
  }
}

function unavailable(): ThemeClientFailure {
  return new ThemeClientFailure({
    category: "unavailable",
    message: "Appearance settings service is unavailable.",
  });
}
