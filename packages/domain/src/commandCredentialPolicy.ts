import type { CommandCredentialDefinition } from "@octant/contracts/command-credentials";
const RESERVED =
  /^(?:OP_|OCTANT_|LD_|DYLD_|GIT_|SSH_|BASH_|NO_COLOR$|TERM$|ENV$|BASH_ENV$|PATH$|HOME$|SHELL$|TMPDIR$|TEMP$|TMP$|NODE_OPTIONS$|NODE_PATH$|BUN_OPTIONS$|PYTHONPATH$|PYTHONHOME$|PYTHONSTARTUP$|PYTHONINSPECT$|RUBYOPT$|RUBYLIB$|PERL5OPT$|PERL5LIB$|PERLLIB$|JAVA_TOOL_OPTIONS$|JDK_JAVA_OPTIONS$|CLASSPATH$)/;
export function commandCredentialDefinitionAllowed(
  definition: CommandCredentialDefinition,
): boolean {
  if (!definition.executable.startsWith("/") || definition.executable.startsWith("//"))
    return false;
  const base = definition.executable.split("/").at(-1)?.toLowerCase();
  if (
    base === undefined ||
    ["sh", "bash", "zsh", "fish", "cmd", "cmd.exe", "powershell", "powershell.exe"].includes(
      base,
    ) ||
    definition.args.includes("-c")
  )
    return false;
  if (
    definition.directory.startsWith("/") ||
    definition.directory.includes("\\") ||
    definition.directory.split("/").some((part) => part === ".." || part === ".")
  )
    return false;
  const names = new Set<string>();
  for (const field of definition.environment) {
    if (RESERVED.test(field.name) || names.has(field.name)) return false;
    names.add(field.name);
  }
  return true;
}
