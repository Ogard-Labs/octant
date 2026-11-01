import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import type { SkillFolderProvider, SkillFolderSettings } from "@octant/contracts";
import type { ExtraSkillRoot } from "./skillDiscoveryService";

/** Where each key provider keeps its own skills, below the person's home folder. */
function providerSkillsFolder(
  provider: SkillFolderProvider,
  home: string,
  env: Readonly<Record<string, string | undefined>>,
): string {
  switch (provider) {
    case "claude":
      return join(home, ".claude", "skills");
    case "codex": {
      const codexHome = env["CODEX_HOME"];
      return join(
        codexHome !== undefined && codexHome !== "" ? codexHome : join(home, ".codex"),
        "skills",
      );
    }
  }
}

/**
 * The extra skill roots the person chose: the key providers' folders they
 * turned on and the folders they added. Octant adds none on its own. A folder
 * that is the user-global root, or listed twice, is read once.
 */
export function extraSkillRootsFromSettings(
  settings: SkillFolderSettings,
  options: {
    readonly home: string;
    readonly userGlobalSkillsRoot: string;
    readonly env?: Readonly<Record<string, string | undefined>>;
  },
): ReadonlyArray<ExtraSkillRoot> {
  const seen = new Set<string>([resolve(options.userGlobalSkillsRoot)]);
  const roots: ExtraSkillRoot[] = [];
  const add = (sourceRef: string, path: string) => {
    const key = resolve(path);
    if (seen.has(key)) return;
    seen.add(key);
    roots.push({ sourceRef, path: key });
  };
  for (const provider of settings.providers) {
    add(
      `provider:${provider}`,
      providerSkillsFolder(provider, options.home, options.env ?? process.env),
    );
  }
  for (const folder of settings.folders) {
    add(
      `folder:${createHash("sha256").update(resolve(folder)).digest("hex").slice(0, 16)}`,
      folder,
    );
  }
  return roots;
}
