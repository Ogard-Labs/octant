import { OCTANT_CREDENTIAL_TOOL } from "@octant/contracts/credential-request";
import { createCredentialCodeTool } from "@octant/plugin-host/code-tools";
import type {
  CodeToolOperationEntry,
  CodeToolSavedCommandEntry,
} from "@octant/plugin-api/code-tools";
import { withToolFamilyHelp, type AppManagedToolSet } from "../providers/appManagedToolSet";

type ToolResult = { readonly result: unknown; readonly isError: boolean };

/**
 * One side of the credential tool. Each side keeps its own authority check:
 * `list` and `use` re-check it on every call, and `offered` is that check plus
 * "this caller has something to use", taken once when the turn's tools are
 * composed.
 */
export interface CredentialToolSource<Entry> {
  readonly offered: boolean;
  /** Names and descriptions, or undefined while this side refuses the caller. */
  readonly list: () => ReadonlyArray<Entry> | undefined;
  readonly use: (id: string | undefined, signal: AbortSignal | undefined) => Promise<ToolResult>;
  readonly close: () => Promise<void>;
}

const CREDENTIAL_TOOL_HELP = [
  "octant_credential uses a credential the person holds. You never see the value, and you cannot approve anything yourself.",
  "- list: the registered credential operations (id, label, reason) and the saved credential commands (id, label, executable, arguments, Project directory) available to this thread. Names and descriptions only.",
  "- request with id: opens a private card in this Code conversation so the person can enter a token for that one registered operation. The host fixes the destination; the result is only its status (used, declined, cancelled, expired, failed).",
  "- run-saved with id: asks the person to review and approve one run of that saved command. Ordinary command approvals and Auto Shield still apply. Below Full access the command stays OS-confined under the thread's file and network rules while the credential tool signs in outside the sandbox; Full access stays unrestricted. The result is the command's exit status and its bounded output; the credential store returns no secret values, but masking cannot stop a command from deliberately disclosing one to a destination it is allowed to reach.",
  "Plan refuses every operation but help. For anything else, including commands that need no credential, use the terminal or shell.",
].join("\n");

/**
 * Octant's one credential tool, composed from the sides this caller can use.
 * It is offered only when at least one side has something to use, and an
 * operation whose side was not offered when the turn began stays refused for
 * the whole turn, so the schema the provider saw is exactly what it can call.
 */
export function createCredentialTool<
  Registered extends CodeToolOperationEntry,
  Saved extends CodeToolSavedCommandEntry,
>(sides: {
  readonly registered: CredentialToolSource<Registered>;
  readonly saved: CredentialToolSource<Saved>;
}): AppManagedToolSet {
  const registered = sides.registered.offered ? sides.registered : undefined;
  const saved = sides.saved.offered ? sides.saved : undefined;
  const set = createCredentialCodeTool({
    name: OCTANT_CREDENTIAL_TOOL.name,
    description: OCTANT_CREDENTIAL_TOOL.description,
    port: {
      operations: () => registered?.list()?.map(({ id, label, reason }) => ({ id, label, reason })),
      savedCommands: () => saved?.list()?.map(({ id, label }) => ({ id, label })),
      request: async (id, signal) =>
        registered === undefined
          ? { result: { status: "refused" }, isError: true }
          : registered.use(id, signal),
      runSaved: async (id, signal) =>
        saved === undefined
          ? { result: { status: "refused" }, isError: true }
          : saved.use(id, signal),
      close: async () => {
        await Promise.all([sides.registered.close(), sides.saved.close()]);
      },
    },
  });
  return withToolFamilyHelp(
    {
      ...set,
      execute: async (call) => {
        const reply = await set.execute(call);
        if (reply.isError === true || !requestsList(call.inputJson)) return reply;
        // Core already shows task-owned command presentation facts. Keep those
        // here; the installed-plugin capability exposes only id and label.
        const registeredEntries = registered?.list();
        const savedEntries = saved?.list();
        if (registeredEntries === undefined && savedEntries === undefined)
          return { result: { status: "refused" }, isError: true };
        return {
          result: { operations: registeredEntries ?? [], savedCommands: savedEntries ?? [] },
          isError: false,
        };
      },
    },
    { [OCTANT_CREDENTIAL_TOOL.name]: CREDENTIAL_TOOL_HELP },
  );
}

function requestsList(inputJson: string): boolean {
  try {
    const input: unknown = JSON.parse(inputJson);
    return (
      typeof input === "object" &&
      input !== null &&
      "operation" in input &&
      input.operation === "list"
    );
  } catch {
    return false;
  }
}
