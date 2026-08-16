import {
  decodeValidationCompositionFailure,
  decodeValidationEvidenceRequest,
  decodeValidationEvidenceSnapshot,
  type ValidationCompositionFailure,
  type ValidationEvidenceRequest,
  type ValidationEvidenceSnapshot,
} from "@octant/contracts/validation-rpc";

export interface ValidationEvidenceClientOptions {
  readonly baseUrl: string;
  readonly fetch: typeof globalThis.fetch;
  readonly windowCapability: string;
}

export interface ValidationEvidenceClient {
  inspect(
    request: ValidationEvidenceRequest,
    signal?: AbortSignal,
  ): Promise<ValidationEvidenceSnapshot>;
}

export type ValidationEvidenceClientFailureCategory =
  | ValidationCompositionFailure["category"]
  | "interrupted"
  | "protocol";

export class ValidationEvidenceClientFailure extends Error {
  readonly category: ValidationEvidenceClientFailureCategory;

  constructor(category: ValidationEvidenceClientFailureCategory, message: string) {
    super(message);
    this.name = "ValidationEvidenceClientFailure";
    this.category = category;
  }
}

export function createValidationEvidenceClient(
  options: ValidationEvidenceClientOptions,
): ValidationEvidenceClient {
  const headers = {
    "content-type": "application/json",
    "x-octant-window-capability": options.windowCapability,
  };
  return {
    async inspect(input, signal) {
      let request: ValidationEvidenceRequest;
      try {
        request = decodeValidationEvidenceRequest(input);
      } catch {
        throw protocol("Validation evidence request is invalid.");
      }
      const snapshot = await post(
        options,
        "/api/validation/evidence",
        request,
        signal,
        decodeValidationEvidenceSnapshot,
        headers,
      );
      return snapshot;
    },
  };
}

async function post<T>(
  options: ValidationEvidenceClientOptions,
  path: string,
  body: unknown,
  signal: AbortSignal | undefined,
  decodeSuccess: (input: unknown) => T,
  headers: Readonly<Record<string, string>>,
): Promise<T> {
  let response: Response;
  try {
    const fetch = options.fetch;
    response = await fetch(new URL(path, options.baseUrl), {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      ...(signal === undefined ? {} : { signal }),
    });
  } catch (error) {
    if (signal?.aborted === true || isAbortError(error)) {
      throw new ValidationEvidenceClientFailure(
        "interrupted",
        "Validation evidence request was interrupted.",
      );
    }
    throw new ValidationEvidenceClientFailure(
      "unavailable",
      "Octant validation evidence service is unavailable.",
    );
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw protocol("Validation evidence service returned an invalid response.");
  }
  if (!response.ok) {
    try {
      const failure = decodeValidationCompositionFailure(payload);
      throw new ValidationEvidenceClientFailure(failure.category, failure.message);
    } catch (error) {
      if (error instanceof ValidationEvidenceClientFailure) throw error;
      throw protocol("Validation evidence service returned an invalid response.");
    }
  }
  try {
    return decodeSuccess(payload);
  } catch {
    throw protocol("Validation evidence service returned an invalid response.");
  }
}

function protocol(message: string): ValidationEvidenceClientFailure {
  return new ValidationEvidenceClientFailure("protocol", message);
}

function isAbortError(error: unknown): boolean {
  return (
    typeof error === "object" && error !== null && "name" in error && error.name === "AbortError"
  );
}
