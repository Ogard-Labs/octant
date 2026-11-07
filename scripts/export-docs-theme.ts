import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_DARK_TOKENS,
  DEFAULT_LIGHT_TOKENS,
  THEME_TOKEN_ROLE_IDS,
} from "@octant/theme/tokens";

const sourceRevision = execFileSync(
  "git",
  ["log", "-1", "--format=%H", "--", "packages/theme/src/tokens.ts"],
  {
    cwd: fileURLToPath(new URL("../", import.meta.url)),
    encoding: "utf8",
  },
).trim();

console.log(
  JSON.stringify(
    {
      source: `https://github.com/Ogard-Labs/octant/blob/${sourceRevision}/packages/theme/src/tokens.ts`,
      roles: THEME_TOKEN_ROLE_IDS,
      light: DEFAULT_LIGHT_TOKENS,
      dark: DEFAULT_DARK_TOKENS,
    },
    null,
    2,
  ),
);
