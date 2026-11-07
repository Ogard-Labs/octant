import type { CommandCredentialDefinition } from "@octant/contracts/command-credentials";
/** Only references leave this adapter. op resolves them directly in its fixed child. */
export function onePasswordCommandCredentials(definition: CommandCredentialDefinition): {
  readonly args: ReadonlyArray<string>;
  readonly environment: Readonly<Record<string, string>>;
} {
  return {
    args: [
      "run",
      "--account",
      definition.accountId,
      "--",
      definition.executable,
      ...definition.args,
    ],
    environment: Object.fromEntries(
      definition.environment.map((field) => [
        field.name,
        `op://${field.vaultId}/${field.itemId}/${field.sectionId === undefined ? "" : `${field.sectionId}/`}${field.fieldId}`,
      ]),
    ),
  };
}
