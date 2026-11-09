import { OCTANT_CREDENTIAL_TOOL } from "@octant/contracts/credential-request";
import type {
  CodeToolContribution,
  CodeToolHostPort,
  CodeToolSet,
} from "@octant/plugin-api/code-tools";

/** Names are assigned from host-owned identity, never supplied by a package. */
export function contributedCodeToolName(packageId: string, componentId: string): string {
  return `octant_plugin_${packageId.replaceAll("-", "")}_${componentId.replaceAll("-", "_")}`;
}

/** A declaration can only narrow the host port's already admitted capabilities. */
export function createContributedCodeTool(input: {
  readonly name: string;
  readonly contribution: CodeToolContribution;
  readonly port: CodeToolHostPort;
}): CodeToolSet {
  const { contribution, port, name } = input;
  const operations = () =>
    port.operations()?.filter((entry) => contribution.operationIds.includes(entry.id));
  const savedCommands = () =>
    port.savedCommands()?.filter((entry) => contribution.savedCommandIds.includes(entry.id));
  const offeredOperations = operations() ?? [];
  const offeredSaved = savedCommands() ?? [];
  const offered = offeredOperations.length + offeredSaved.length > 0;
  const actions = [
    "help",
    "list",
    ...(offeredOperations.length === 0 ? [] : ["request"]),
    ...(offeredSaved.length === 0 ? [] : ["run-saved"]),
  ];
  let closed = false;
  const refused = { result: { status: "refused" }, isError: true } as const;
  return {
    definitions: !offered
      ? []
      : [
          {
            name,
            description: `${contribution.description} The host retains credentials and approvals. Call list for allowed IDs; arbitrary commands, URLs and credentials are unavailable.`,
            inputSchema: {
              ...OCTANT_CREDENTIAL_TOOL.inputSchema,
              properties: {
                ...OCTANT_CREDENTIAL_TOOL.inputSchema.properties,
                operation: { type: "string", enum: actions },
              },
            },
          },
        ],
    close: async () => {
      if (!closed) {
        closed = true;
        await port.close();
      }
    },
    execute: async (call) => {
      if (closed || !offered || call.name !== name || call.signal?.aborted) return refused;
      const availableOperations = operations();
      const availableSaved = savedCommands();
      if (availableOperations === undefined && availableSaved === undefined) return refused;
      let value: unknown;
      try {
        value = call.inputJson.length > 1024 ? undefined : JSON.parse(call.inputJson);
      } catch {
        return refused;
      }
      if (
        typeof value !== "object" ||
        value === null ||
        !("operation" in value) ||
        Object.keys(value).some((key) => key !== "operation" && key !== "id")
      )
        return refused;
      const id = "id" in value ? value.id : undefined;
      if (value.operation === "help" && id === undefined)
        return {
          result: {
            tool: name,
            help: "list shows only the declared operations and saved commands this Code turn may use. request opens a private credential card; run-saved asks the person to review a saved command. Neither action returns credentials or approves itself. Plan refuses.",
          },
          isError: false,
        };
      if (value.operation === "list" && id === undefined)
        return {
          result: {
            operations:
              availableOperations?.map(({ id, label, reason }) => ({ id, label, reason })) ?? [],
            savedCommands: availableSaved?.map(({ id, label }) => ({ id, label })) ?? [],
          },
          isError: false,
        };
      if (typeof id !== "string") return refused;
      const result =
        value.operation === "request" &&
        offeredOperations.some((entry) => entry.id === id) &&
        availableOperations?.some((entry) => entry.id === id)
          ? await port.request(id, call.signal)
          : value.operation === "run-saved" &&
              offeredSaved.some((entry) => entry.id === id) &&
              availableSaved?.some((entry) => entry.id === id)
            ? await port.runSaved(id, call.signal)
            : refused;
      return closed || (operations() === undefined && savedCommands() === undefined)
        ? refused
        : result;
    },
  };
}
