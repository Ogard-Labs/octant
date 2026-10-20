import type { ExtensionSnapshot } from "@octant/contracts/extension-rpc";
import { isExtensionComponentModeSafe } from "@octant/plugin-host";
import { driverLabel } from "../providers/providerSettingsPresentation";

type InstalledPackage = ExtensionSnapshot["packages"][number];

const MODE_LABEL = { chat: "Chat", work: "Work", code: "Code" } as const;
const MODE_ORDER = ["work", "code", "chat"] as const;

export interface ProviderFit {
  /** "Works in Work and Code with every provider." */
  readonly sentence: string;
  /** One line per mode where only part of the package applies, in plain words. */
  readonly limits: ReadonlyArray<string>;
}

/**
 * Where a package works, in words a person can act on: the modes its
 * manifest allows, narrowed to the modes each of its components may run in,
 * and the provider families it names, or every provider when it names none.
 * The same rules the host applies at activation decide the words here; the
 * card never claims more than the host would allow.
 */
export function providerFit(pkg: InstalledPackage): ProviderFit {
  const modes = MODE_ORDER.filter((mode) => pkg.compatibility.modes.includes(mode));
  const components = pkg.components.map((state) => state.component);
  const full: string[] = [];
  const limits: string[] = [];
  for (const mode of modes) {
    const safe = components.filter((component) => isExtensionComponentModeSafe(mode, component));
    if (components.length === 0 || safe.length === components.length) {
      full.push(MODE_LABEL[mode]);
      continue;
    }
    if (safe.length === 0) {
      limits.push(`Not in ${MODE_LABEL[mode]}: none of its parts may run there.`);
      continue;
    }
    const kept = describeKinds(safe.map((component) => component.kind));
    limits.push(`In ${MODE_LABEL[mode]}, ${kept} only.`);
  }
  const providers =
    pkg.compatibility.providerFamilies.length === 0
      ? "every provider"
      : joinWords(pkg.compatibility.providerFamilies.map((family) => familyLabel(String(family))));
  const sentence =
    full.length === 0
      ? `Needs a provider among ${providers}.`
      : `Works in ${joinWords(full)} with ${providers}.`;
  if (components.some((component) => component.kind === "mcp-server")) {
    limits.push(
      "A provider that cannot carry Octant's tools refuses a turn that selects its servers.",
    );
  }
  return { sentence, limits };
}

function describeKinds(kinds: ReadonlyArray<string>): string {
  const names = new Set<string>();
  for (const kind of kinds) {
    if (kind === "skill-instructions") names.add("its skills");
    else if (kind === "mcp-server" || kind === "mcp-tool" || kind === "mcp-prompt") {
      names.add("its servers");
    } else names.add("some parts");
  }
  return joinWords([...names]);
}

function familyLabel(family: string): string {
  try {
    return driverLabel(family as never) ?? family;
  } catch {
    return family;
  }
}

function joinWords(words: ReadonlyArray<string>): string {
  if (words.length <= 1) return words[0] ?? "";
  return `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`;
}
