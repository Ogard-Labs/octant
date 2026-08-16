import type { SkillMarketplacePort } from "./standaloneSkillService";
import { NPM_SKILLS_CATALOG_ID, SKILLS_SH_CATALOG_ID } from "./skillPackageBuilder";
import { NpmSkillMarketplace } from "./npmSkillMarketplace";
import { SkillsShMarketplace } from "./skillsShMarketplace";

export function createCompositeSkillMarketplace(
  options: {
    readonly fetch?: typeof globalThis.fetch;
    readonly appVersion?: string;
    readonly platform?: NodeJS.Platform;
    readonly skillsSh?: SkillMarketplacePort;
    readonly npm?: SkillMarketplacePort;
  } = {},
): SkillMarketplacePort {
  const skillsSh =
    options.skillsSh ??
    new SkillsShMarketplace({
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      ...(options.appVersion === undefined ? {} : { appVersion: options.appVersion }),
      ...(options.platform === undefined ? {} : { platform: options.platform }),
    });
  const npm =
    options.npm ??
    new NpmSkillMarketplace({
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      ...(options.appVersion === undefined ? {} : { appVersion: options.appVersion }),
      ...(options.platform === undefined ? {} : { platform: options.platform }),
    });

  return {
    async search(query, cursor, signal) {
      const [skillsShResult, npmResult] = await Promise.allSettled([
        skillsSh.search(query, cursor, signal),
        npm.search(query, cursor, signal),
      ]);
      const entries = [
        ...(skillsShResult.status === "fulfilled" ? skillsShResult.value.entries : []),
        ...(npmResult.status === "fulfilled" ? npmResult.value.entries : []),
      ];
      if (
        skillsShResult.status === "rejected" &&
        npmResult.status === "rejected" &&
        entries.length === 0
      ) {
        throw new Error("Skill marketplace search is unavailable.");
      }
      return { entries: entries.slice(0, 64) };
    },
    async resolve(source, signal) {
      if (source.kind === "catalog" && source.catalogId === SKILLS_SH_CATALOG_ID) {
        return skillsSh.resolve(source, signal);
      }
      if (source.kind === "catalog" && source.catalogId === NPM_SKILLS_CATALOG_ID) {
        return npm.resolve(source, signal);
      }
      throw new Error("Skill marketplace cannot resolve this source.");
    },
  };
}
