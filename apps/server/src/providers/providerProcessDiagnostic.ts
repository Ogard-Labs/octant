import type { ProviderProcessDiagnostic } from "@octant/contracts";

const DEFAULT_STDERR_BYTES = 4_096;

export interface BoundedProviderStderr {
  readonly append: (chunk: Buffer | string) => void;
  readonly context: () => ProviderProcessDiagnostic["stderrContext"];
}

export function makeBoundedProviderStderr(limit = DEFAULT_STDERR_BYTES): BoundedProviderStderr {
  let captured = Buffer.alloc(0);
  return {
    append: (chunk) => {
      if (captured.length >= limit) return;
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      captured = Buffer.concat([captured, bytes.subarray(0, limit - captured.length)]);
    },
    context: () => classifyProviderStderr(captured.toString("utf8")),
  };
}

export function classifyProviderStderr(value: string): ProviderProcessDiagnostic["stderrContext"] {
  if (value.trim().length === 0) return undefined;
  if (/operation not permitted|permission denied/i.test(value)) {
    return "Provider process was denied by host confinement.";
  }
  if (/unexpected argument|unrecognized (?:option|argument)|unknown option|usage:/i.test(value)) {
    return "Provider process rejected its configured arguments.";
  }
  if (/not authenticated|authentication required|login required|unauthorized/i.test(value)) {
    return "Provider authentication is required.";
  }
  if (/certificate|tls|osstatus\s+-26276/i.test(value)) {
    return "Provider TLS trust verification failed.";
  }
  if (
    /connection refused|name or service not known|could not resolve host|network is unreachable/i.test(
      value,
    )
  ) {
    return "Provider network connection failed.";
  }
  return "Provider process wrote redacted diagnostic output.";
}
