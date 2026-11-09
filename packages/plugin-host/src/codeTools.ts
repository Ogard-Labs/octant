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

const refused = { result: { status: "refused" }, isError: true } as const;
const invalid = { result: { status: "invalid" }, isError: true } as const;
const DEFAULT_HELP =
  "list shows only the declared operations and saved commands this Code turn may use. request opens a private credential card; run-saved asks the person to review a saved command. Neither action returns credentials or approves itself. Plan refuses.";

/** Compose the credential family using only a host-issued capability port. */
export function createCredentialCodeTool(input: {
  readonly name: string;
  readonly description: string;
  readonly port: CodeToolHostPort;
}): CodeToolSet {
  const { port, name } = input;
  const registered = (port.operations()?.length ?? 0) > 0;
  const saved = (port.savedCommands()?.length ?? 0) > 0;
  const offered = registered || saved;
  const actions = [
    "help",
    "list",
    ...(registered ? ["request"] : []),
    ...(saved ? ["run-saved"] : []),
  ];
  let closing: Promise<void> | undefined;
  return {
    definitions: !offered
      ? []
      : [
          {
            ...OCTANT_CREDENTIAL_TOOL,
            name,
            description: input.description,
            inputSchema: {
              ...OCTANT_CREDENTIAL_TOOL.inputSchema,
              properties: {
                ...OCTANT_CREDENTIAL_TOOL.inputSchema.properties,
                operation: { type: "string", enum: actions },
              },
            },
          },
        ],
    close: () => {
      closing ??= port.close();
      return closing;
    },
    execute: async (call) => {
      if (!offered || call.name !== name) return refused;
      let value: unknown;
      try {
        value = call.inputJson.length > 1024 ? undefined : JSON.parse(call.inputJson);
      } catch {
        return invalid;
      }
      if (
        typeof value !== "object" ||
        value === null ||
        !("operation" in value) ||
        Object.keys(value).some((key) => key !== "operation" && key !== "id")
      )
        return invalid;
      const id = "id" in value ? value.id : undefined;
      if (id !== undefined && typeof id !== "string") return invalid;
      switch (value.operation) {
        case "help":
          if (id !== undefined) return invalid;
          if (port.operations() === undefined && port.savedCommands() === undefined) return refused;
          return { result: { tool: name, help: DEFAULT_HELP }, isError: false };
        case "list": {
          if (id !== undefined) return invalid;
          const operations = registered ? port.operations() : undefined;
          const commands = saved ? port.savedCommands() : undefined;
          if (operations === undefined && commands === undefined) return refused;
          return {
            result: {
              operations: operations?.map(({ id, label, reason }) => ({ id, label, reason })) ?? [],
              savedCommands: commands?.map(({ id, label }) => ({ id, label })) ?? [],
            },
            isError: false,
          };
        }
        case "request":
          if (!registered || port.operations() === undefined) return refused;
          return id === undefined
            ? { result: { status: "unsupported-operation" }, isError: true }
            : port.request(id, call.signal);
        case "run-saved":
          if (!saved || port.savedCommands() === undefined) return refused;
          return id === undefined ? invalid : port.runSaved(id, call.signal);
        default:
          return invalid;
      }
    },
  };
}

/** A declaration can only narrow the host port's already admitted capabilities. */
export function createContributedCodeTool(input: {
  readonly name: string;
  readonly contribution: CodeToolContribution;
  readonly port: CodeToolHostPort;
}): CodeToolSet {
  const { contribution, port, name } = input;
  const initialOperations =
    port.operations()?.filter((entry) => contribution.operationIds.includes(entry.id)) ?? [];
  const initialSaved =
    port.savedCommands()?.filter((entry) => contribution.savedCommandIds.includes(entry.id)) ?? [];
  const operations = () =>
    port
      .operations()
      ?.filter((entry) => initialOperations.some((offered) => offered.id === entry.id));
  const savedCommands = () =>
    port
      .savedCommands()
      ?.filter((entry) => initialSaved.some((offered) => offered.id === entry.id));
  let closed = false;
  const set = createCredentialCodeTool({
    name,
    description: `${contribution.description} The host retains credentials and approvals. Call list for allowed IDs; arbitrary commands, URLs and credentials are unavailable.`,
    port: {
      operations,
      savedCommands,
      request: async (id, signal) =>
        operations()?.some((entry) => entry.id === id) ? port.request(id, signal) : refused,
      runSaved: async (id, signal) =>
        savedCommands()?.some((entry) => entry.id === id) ? port.runSaved(id, signal) : refused,
      close: () => port.close(),
    },
  });
  return {
    ...set,
    close: async () => {
      closed = true;
      await set.close();
    },
    execute: async (call) => {
      if (
        closed ||
        call.signal?.aborted ||
        (operations() === undefined && savedCommands() === undefined)
      )
        return refused;
      const result = await set.execute(call);
      return closed || (operations() === undefined && savedCommands() === undefined)
        ? refused
        : result;
    },
  };
}
