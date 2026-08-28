import type { SkillMarketplacePort } from "./standaloneSkillService";
import { NPM_SKILLS_CATALOG_ID, SKILLS_SH_CATALOG_ID } from "./skillPackageBuilder";
import { NpmSkillMarketplace } from "./npmSkillMarketplace";
import { SkillsShMarketplace } from "./skillsShMarketplace";
import { createMarketplaceFetch, MarketplaceFetchesDisabledError } from "./marketplaceHttps";

export function createCompositeSkillMarketplace(
  options: {
    readonly fetch?: typeof globalThis.fetch;
    readonly appVersion?: string;
    readonly platform?: NodeJS.Platform;
    readonly skillsSh?: SkillMarketplacePort;
    readonly npm?: SkillMarketplacePort;
    /** When false, skills.sh / npm requests are not made. */
    readonly isMarketplaceFetchAllowed?: () => boolean;
  } = {},
): SkillMarketplacePort {
  const fetchImpl =
    options.isMarketplaceFetchAllowed === undefined && options.fetch === undefined
      ? undefined
      : createMarketplaceFetch({
          ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
          ...(options.isMarketplaceFetchAllowed === undefined
            ? {}
            : { isAllowed: options.isMarketplaceFetchAllowed }),
        });
  const skillsSh =
    options.skillsSh ??
    new SkillsShMarketplace({
      ...(fetchImpl === undefined ? {} : { fetch: fetchImpl }),
      ...(options.appVersion === undefined ? {} : { appVersion: options.appVersion }),
      ...(options.platform === undefined ? {} : { platform: options.platform }),
    });
  const npm =
    options.npm ??
    new NpmSkillMarketplace({
      ...(fetchImpl === undefined ? {} : { fetch: fetchImpl }),
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
        if (
          skillsShResult.reason instanceof MarketplaceFetchesDisabledError ||
          npmResult.reason instanceof MarketplaceFetchesDisabledError
        ) {
          throw skillsShResult.reason instanceof MarketplaceFetchesDisabledError
            ? skillsShResult.reason
            : npmResult.reason;
        }
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
