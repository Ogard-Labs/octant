import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_DARK_TOKENS,
  DEFAULT_LIGHT_TOKENS,
  THEME_TOKEN_ROLE_IDS,
} from "@octant/theme/tokens";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const themeChanges = execFileSync(
  "git",
  ["status", "--porcelain", "--untracked-files=all", "--", "packages/theme"],
  { cwd: repositoryRoot, encoding: "utf8" },
).trim();
if (themeChanges !== "") {
  console.error("Commit theme sources before exporting their immutable reference.");
  process.exit(1);
}
const sourceRevision = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: repositoryRoot,
  encoding: "utf8",
}).trim();

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
