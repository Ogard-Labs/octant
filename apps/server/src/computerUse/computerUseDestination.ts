export type ComputerUseDestinationReport =
  | { readonly status: "available"; readonly kind: "macos-host" }
  | { readonly status: "unavailable"; readonly kind: "no-destination" | "no-provider-configured" };

export type ComputerUseDestinationRefusal = {
  readonly status: "refused";
  readonly kind: "unavailable";
  readonly reason: "no-destination" | "no-provider-configured";
};

export function reportComputerUseDestination(input: {
  readonly platform: NodeJS.Platform;
  readonly providerConfigured?: boolean;
}): ComputerUseDestinationReport {
  if (input.platform === "darwin") {
    return { status: "available", kind: "macos-host" };
  }
  if (input.providerConfigured === true) {
    return { status: "unavailable", kind: "no-destination" };
  }
  return { status: "unavailable", kind: "no-provider-configured" };
}

export function refuseComputerUseDestination(
  destination: ComputerUseDestinationReport,
): ComputerUseDestinationRefusal | undefined {
  if (destination.status === "available") return undefined;
  return {
    status: "refused",
    kind: "unavailable",
    reason: destination.kind,
  };
}

export function isComputerUseDestinationRefusal(
  result: unknown,
): result is ComputerUseDestinationRefusal {
  if (typeof result !== "object" || result === null) return false;
  if (!("status" in result) || !("kind" in result) || !("reason" in result)) return false;
  return (
    result.status === "refused" &&
    result.kind === "unavailable" &&
    (result.reason === "no-destination" || result.reason === "no-provider-configured")
  );
}
