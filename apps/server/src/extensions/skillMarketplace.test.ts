import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { decodeExtensionCommandResult } from "@octant/contracts/extension-rpc";
import {
  NPM_SKILLS_CATALOG_ID,
  SKILLS_SH_CATALOG_ID,
  buildStandaloneSkillPackage,
  decodeSkillCatalogEntryId,
  encodeSkillCatalogEntryId,
  parseSkillMarkdown,
} from "./skillPackageBuilder";
import { SkillsShMarketplace } from "./skillsShMarketplace";
import {
  NpmSkillMarketplace,
  decodeNpmEntryId,
  encodeNpmEntryId,
  extractSkillMarkdownFromTarball,
  verifyNpmTarballIntegrity,
} from "./npmSkillMarketplace";
import { createCompositeSkillMarketplace } from "./compositeSkillMarketplace";
import { inspectExtensionPackage } from "./packageInspector";

const FRONTEND_ENTRY_ID = encodeSkillCatalogEntryId({
  owner: "anthropics",
  repo: "skills",
  skillId: "frontend-design",
});
const GITHUB_COMMIT = "a".repeat(40);

describe("skill package builder", () => {
  it("encodes and decodes skills.sh catalog entry ids reversibly", () => {
    expect(decodeSkillCatalogEntryId(FRONTEND_ENTRY_ID)).toEqual({
      owner: "anthropics",
      repo: "skills",
      skillId: "frontend-design",
    });
    const dotted = encodeSkillCatalogEntryId({
      owner: "foo.bar",
      repo: "skills",
      skillId: "review_v2",
    });
    const dashed = encodeSkillCatalogEntryId({
      owner: "foo-bar",
      repo: "skills",
      skillId: "review-v2",
    });
    expect(dotted).not.toBe(dashed);
    expect(decodeSkillCatalogEntryId(dotted)).toEqual({
      owner: "foo.bar",
      repo: "skills",
      skillId: "review_v2",
    });
    const ordinaryLongIdentity = {
      owner: "octant-community",
      repo: "agent-productivity",
      skillId: "frontend-review-kit",
    };
    const compact = encodeSkillCatalogEntryId(ordinaryLongIdentity);
    expect(compact.length).toBeLessThanOrEqual(96);
    expect(decodeSkillCatalogEntryId(compact)).toEqual(ordinaryLongIdentity);
  });

  it("rejects oversized skills.sh identities instead of hashing", () => {
    expect(() =>
      encodeSkillCatalogEntryId({
        owner: "a".repeat(40),
        repo: "b".repeat(40),
        skillId: "c".repeat(40),
      }),
    ).toThrow(/too long/i);
  });

  it("requires skill license frontmatter", () => {
    expect(() =>
      parseSkillMarkdown(
        `---
name: no-license
description: Missing license.
---
Body
`,
        "no-license",
      ),
    ).toThrow(/license/i);
  });

  it("parses folded YAML scalars in standalone skill frontmatter", () => {
    const parsed = parseSkillMarkdown(
      `---
name: folded-license
description: >
  Review changes
  carefully.
license: >
  MIT
---
Body
`,
      "folded-license",
    );
    expect(parsed.description).toBe("Review changes carefully.");
    expect(parsed.license).toBe("MIT");
  });

  it("accepts verified package-level SPDX metadata when SKILL.md omits license", () => {
    const markdown = `---
name: frontend-design
description: Distinctive frontend guidance.
---
Body
`;
    const resolved = buildStandaloneSkillPackage({
      source: {
        kind: "catalog",
        catalogId: SKILLS_SH_CATALOG_ID as never,
        entryId: FRONTEND_ENTRY_ID as never,
      },
      slug: "frontend-design",
      displayName: "frontend-design",
      publisher: "anthropics",
      canonicalUrl: "https://github.com/anthropics/skills",
      packageLicense: "MIT",
      skills: [{ directoryName: "frontend-design", markdown }],
      appVersion: "1.0.0",
      platform: "darwin",
    });

    expect(inspectExtensionPackage(resolved).manifest.license).toEqual({
      kind: "spdx",
      identifier: "MIT",
    });
  });

  it("builds an inspectable standalone skill package from SKILL.md", () => {
    const markdown = `---
name: frontend-design
description: Distinctive frontend guidance.
license: MIT
---
Body
`;
    const resolved = buildStandaloneSkillPackage({
      source: {
        kind: "catalog",
        catalogId: SKILLS_SH_CATALOG_ID as never,
        entryId: FRONTEND_ENTRY_ID as never,
      },
      slug: "frontend-design",
      displayName: "frontend-design",
      publisher: "anthropics",
      canonicalUrl: "https://github.com/anthropics/skills",
      skills: [{ directoryName: "frontend-design", markdown }],
      appVersion: "1.0.0",
      platform: "darwin",
    });
    const inspected = inspectExtensionPackage(resolved);
    expect(inspected.manifest.components).toEqual([
      expect.objectContaining({
        id: "frontend-design",
        kind: "skill-instructions",
      }),
    ]);
    expect(parseSkillMarkdown(markdown, "frontend-design").description).toContain("Distinctive");
  });

  it("preserves digit-prefixed Agent Skill names behind a valid component token", () => {
    const name = "3d-modeling";
    const resolved = buildStandaloneSkillPackage({
      source: {
        kind: "catalog",
        catalogId: SKILLS_SH_CATALOG_ID as never,
        entryId: FRONTEND_ENTRY_ID as never,
      },
      slug: name,
      displayName: name,
      publisher: "example",
      canonicalUrl: "https://example.test/skills/3d-modeling",
      skills: [
        {
          directoryName: name,
          markdown: `---\nname: ${name}\ndescription: Three-dimensional modeling guidance.\nlicense: MIT\n---\nBody\n`,
        },
      ],
      appVersion: "1.0.0",
      platform: "darwin",
    });

    const inspected = inspectExtensionPackage(resolved);
    expect(inspected.manifest.components).toEqual([
      expect.objectContaining({
        id: expect.stringMatching(/^skill-[a-f0-9]{16}$/),
        displayName: name,
        contentReference: expect.stringMatching(/^content:skill-[a-f0-9]{16}$/),
      }),
    ]);
    expect(resolved.entries).toEqual([
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ path: `skills/${name}/SKILL.md` }),
    ]);
  });
});

describe("skills.sh marketplace", () => {
  it("preserves digit-prefixed public skill names in search results", async () => {
    const marketplace = new SkillsShMarketplace({
      fetch: (async () =>
        Response.json({
          skills: [
            {
              id: "example/skills/3d-modeling",
              skillId: "3d-modeling",
              name: "3d-modeling",
              source: "example/skills",
            },
          ],
        })) as unknown as typeof fetch,
      platform: "darwin",
    });

    await expect(marketplace.search("3d")).resolves.toMatchObject({
      entries: [{ skill: { name: "3d-modeling" }, displayName: "3d-modeling" }],
    });
  });

  it("evicts old display metadata from the bounded identity cache", async () => {
    let searchIndex = 0;
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("skills.sh/api/search")) {
        const index = searchIndex++;
        return Response.json({
          skills: [
            {
              id: `example/skills/skill-${index}`,
              skillId: `skill-${index}`,
              name: `Friendly skill ${index}`,
              source: "example/skills",
            },
          ],
        });
      }
      if (url === "https://api.github.com/repos/example/skills/commits/HEAD") {
        return Response.json({ sha: GITHUB_COMMIT });
      }
      if (url === `https://api.github.com/repos/example/skills/license?ref=${GITHUB_COMMIT}`) {
        return Response.json({ license: { spdx_id: "MIT" } });
      }
      if (url.includes("api.github.com/repos/example/skills/contents/skills/skill-0")) {
        return Response.json([
          {
            type: "file",
            name: "SKILL.md",
            path: "skills/skill-0/SKILL.md",
            download_url:
              "https://raw.githubusercontent.com/example/skills/main/skills/skill-0/SKILL.md",
            size: 96,
          },
        ]);
      }
      if (url.endsWith("/skills/skill-0/SKILL.md")) {
        return new Response(
          "---\nname: skill-0\ndescription: First skill.\nlicense: MIT\n---\nBody\n",
        );
      }
      return new Response("missing", { status: 404 });
    }) as typeof fetch;
    const marketplace = new SkillsShMarketplace({ fetch: fetchImpl, platform: "darwin" });
    const first = await marketplace.search("skill-0");
    for (let index = 1; index <= 64; index += 1) {
      await marketplace.search(`skill-${index}`);
    }

    const resolved = await marketplace.resolve(first.entries[0]!.source);
    expect(inspectExtensionPackage(resolved).manifest.displayName).toBe("skill-0");
  });

  it("cancels oversized skills.sh search responses before parsing", async () => {
    let cancelled = false;
    let chunks = 0;
    const response = new Response(
      new ReadableStream<Uint8Array>({
        pull(controller) {
          controller.enqueue(new Uint8Array(512 * 1024));
          chunks += 1;
          if (chunks === 4) controller.close();
        },
        cancel() {
          cancelled = true;
        },
      }),
      { headers: { "content-type": "application/json" } },
    );
    const marketplace = new SkillsShMarketplace({
      fetch: (async () => response) as unknown as typeof fetch,
      platform: "darwin",
    });

    await expect(marketplace.search("react")).rejects.toThrow(/size limits/i);
    expect(cancelled).toBe(true);
  });

  it("bounds recursive GitHub directory traversal", async () => {
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "https://api.github.com/repos/anthropics/skills/commits/HEAD") {
        return Response.json({ sha: GITHUB_COMMIT });
      }
      if (!url.includes("api.github.com/repos/anthropics/skills/contents/")) {
        return new Response("missing", { status: 404 });
      }
      const path = decodeURIComponent(url.split("/contents/")[1] ?? "");
      const depth = path.split("/").length;
      return Response.json([
        { type: "dir", name: `nested-${depth}`, path: `${path}/nested-${depth}` },
      ]);
    }) as typeof fetch;
    const marketplace = new SkillsShMarketplace({ fetch: fetchImpl, platform: "darwin" });

    await expect(
      marketplace.resolve({
        kind: "catalog",
        catalogId: SKILLS_SH_CATALOG_ID as never,
        entryId: FRONTEND_ENTRY_ID as never,
      }),
    ).rejects.toThrow(/traversal limit/i);
  });

  it("searches skills.sh and resolves a GitHub skill tree with nested files", async () => {
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("skills.sh/api/search")) {
        return Response.json({
          skills: [
            {
              id: "anthropics/skills/frontend-design",
              skillId: "frontend-design",
              name: "frontend-design",
              installs: 10,
              source: "anthropics/skills",
            },
          ],
        });
      }
      if (url === "https://api.github.com/repos/anthropics/skills/commits/HEAD") {
        return Response.json({ sha: GITHUB_COMMIT });
      }
      if (url === `https://api.github.com/repos/anthropics/skills/license?ref=${GITHUB_COMMIT}`)
        return new Response("unavailable", { status: 503 });
      if (
        url.includes(
          "api.github.com/repos/anthropics/skills/contents/skills/frontend-design/references",
        )
      ) {
        return Response.json([
          {
            type: "file",
            name: "guide.md",
            path: "skills/frontend-design/references/guide.md",
            download_url:
              "https://raw.githubusercontent.com/anthropics/skills/main/skills/frontend-design/references/guide.md",
            size: 16,
          },
        ]);
      }
      if (url.includes("api.github.com/repos/anthropics/skills/contents/skills/frontend-design")) {
        return Response.json([
          {
            type: "file",
            name: "SKILL.md",
            path: "skills/frontend-design/SKILL.md",
            download_url:
              "https://raw.githubusercontent.com/anthropics/skills/main/skills/frontend-design/SKILL.md",
            size: 64,
          },
          {
            type: "dir",
            name: "references",
            path: "skills/frontend-design/references",
          },
        ]);
      }
      if (
        url.includes(
          `raw.githubusercontent.com/anthropics/skills/${GITHUB_COMMIT}/skills/frontend-design/SKILL.md`,
        )
      ) {
        return new Response(`---
name: frontend-design
description: Distinctive frontend guidance.
license: MIT
---
See [guide](references/guide.md)
`);
      }
      if (
        url.includes(
          `raw.githubusercontent.com/anthropics/skills/${GITHUB_COMMIT}/skills/frontend-design/references/guide.md`,
        )
      ) {
        return new Response("# Guide\n");
      }
      return new Response("missing", { status: 404 });
    }) as typeof fetch;

    const marketplace = new SkillsShMarketplace({ fetch: fetchImpl, platform: "darwin" });
    const search = await marketplace.search("frontend");
    expect(search.entries).toHaveLength(1);
    expect(search.entries[0]?.source).toEqual({
      kind: "catalog",
      catalogId: SKILLS_SH_CATALOG_ID,
      entryId: FRONTEND_ENTRY_ID,
    });
    const resolved = await marketplace.resolve(search.entries[0]!.source);
    const inspected = inspectExtensionPackage(resolved);
    expect(inspected.manifest.slug).toBe("frontend-design");
    expect(inspected.manifest.license).toEqual({ kind: "spdx", identifier: "MIT" });
    expect(inspected.contentReferences["frontend-design"]).toBe("skills/frontend-design/SKILL.md");
    expect(
      resolved.entries.some((entry) => entry.path === "skills/frontend-design/references/guide.md"),
    ).toBe(true);
  });

  it("does not substitute a nested skill when the selected skills.sh root lacks SKILL.md", async () => {
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "https://api.github.com/repos/anthropics/skills/commits/HEAD") {
        return Response.json({ sha: GITHUB_COMMIT });
      }
      if (
        url.includes(
          "api.github.com/repos/anthropics/skills/contents/skills/frontend-design/nested",
        )
      ) {
        return Response.json([
          {
            type: "file",
            name: "SKILL.md",
            path: "skills/frontend-design/nested/SKILL.md",
            download_url:
              "https://raw.githubusercontent.com/anthropics/skills/main/skills/frontend-design/nested/SKILL.md",
            size: 96,
          },
        ]);
      }
      if (url.includes("api.github.com/repos/anthropics/skills/contents/skills/frontend-design")) {
        return Response.json([
          {
            type: "dir",
            name: "nested",
            path: "skills/frontend-design/nested",
          },
        ]);
      }
      if (url.includes("api.github.com/repos/anthropics/skills/contents/frontend-design")) {
        return new Response("missing", { status: 404 });
      }
      if (url.includes("api.github.com/repos/anthropics/skills/git/trees/")) {
        return Response.json({ tree: [] });
      }
      if (url.endsWith("/skills/frontend-design/nested/SKILL.md")) {
        return new Response(
          "---\nname: substituted\ndescription: Wrong nested skill.\nlicense: MIT\n---\nBody\n",
        );
      }
      return new Response("missing", { status: 404 });
    }) as typeof fetch;
    const marketplace = new SkillsShMarketplace({ fetch: fetchImpl, platform: "darwin" });

    await expect(
      marketplace.resolve({
        kind: "catalog",
        catalogId: SKILLS_SH_CATALOG_ID as never,
        entryId: FRONTEND_ENTRY_ID as never,
      }),
    ).rejects.toThrow(/could not be fetched/i);
  });

  it("resolves skills.sh identities from the claimed GitHub repository", async () => {
    let snapshotRequested = false;
    const requestedUrls: string[] = [];
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = String(input);
      requestedUrls.push(url);
      if (url.includes("skills.sh/api/search")) {
        return Response.json({
          skills: [
            {
              id: "vercel-labs/agent-skills/vercel-react-best-practices",
              skillId: "vercel-react-best-practices",
              name: "vercel-react-best-practices",
              source: "vercel-labs/agent-skills",
            },
          ],
        });
      }
      if (
        url ===
        "https://skills.sh/api/download/vercel-labs/agent-skills/vercel-react-best-practices"
      ) {
        snapshotRequested = true;
        return Response.json({
          hash: "a".repeat(64),
          files: [
            {
              path: "SKILL.md",
              contents:
                "---\nname: vercel-react-best-practices\ndescription: Substituted guidance.\n---\nCompromised registry bytes.\n",
            },
          ],
        });
      }
      if (url === "https://api.github.com/repos/vercel-labs/agent-skills/commits/HEAD") {
        return Response.json({ sha: GITHUB_COMMIT });
      }
      if (
        url === `https://api.github.com/repos/vercel-labs/agent-skills/license?ref=${GITHUB_COMMIT}`
      ) {
        return Response.json({ license: { spdx_id: "MIT" } });
      }
      if (
        url.includes(
          "api.github.com/repos/vercel-labs/agent-skills/contents/skills/react-best-practices",
        )
      ) {
        return Response.json([
          {
            type: "file",
            name: "SKILL.md",
            path: "skills/react-best-practices/SKILL.md",
            download_url:
              "https://raw.githubusercontent.com/vercel-labs/agent-skills/main/skills/react-best-practices/SKILL.md",
            size: 128,
          },
          {
            type: "file",
            name: "guide.md",
            path: "skills/react-best-practices/guide.md",
            download_url:
              "https://raw.githubusercontent.com/vercel-labs/agent-skills/main/skills/react-best-practices/guide.md",
            size: 16,
          },
        ]);
      }
      if (
        url.includes(`api.github.com/repos/vercel-labs/agent-skills/git/trees/${GITHUB_COMMIT}`)
      ) {
        return Response.json({
          truncated: false,
          tree: [
            {
              type: "blob",
              path: "skills/react-best-practices/SKILL.md",
              size: 128,
            },
            { type: "blob", path: "skills/react-best-practices/guide.md", size: 16 },
          ],
        });
      }
      if (url.endsWith("/SKILL.md")) {
        return new Response(
          "---\nname: vercel-react-best-practices\ndescription: React guidance.\n---\nTrusted GitHub bytes.\n",
        );
      }
      if (url.endsWith("/guide.md")) return new Response("# Guide\n");
      return new Response("missing", { status: 404 });
    }) as typeof fetch;

    const marketplace = new SkillsShMarketplace({ fetch: fetchImpl, platform: "darwin" });
    const search = await marketplace.search("react");
    const resolved = await marketplace.resolve(search.entries[0]!.source);
    const inspected = inspectExtensionPackage(resolved);

    expect(inspected.manifest.slug).toBe("vercel-react-best-practices");
    expect(inspected.manifest.license).toEqual({ kind: "spdx", identifier: "MIT" });
    expect(requestedUrls).toContain(
      `https://api.github.com/repos/vercel-labs/agent-skills/license?ref=${GITHUB_COMMIT}`,
    );
    expect(snapshotRequested).toBe(false);
    expect(
      requestedUrls.filter(
        (url) =>
          url.includes("/contents/") ||
          url.includes("/git/trees/") ||
          url.includes("raw.githubusercontent.com"),
      ),
    ).toEqual(
      expect.arrayContaining([
        expect.stringContaining(`?ref=${GITHUB_COMMIT}`),
        expect.stringContaining(`/git/trees/${GITHUB_COMMIT}`),
        expect.stringContaining(`/${GITHUB_COMMIT}/skills/react-best-practices/SKILL.md`),
      ]),
    );
    expect(requestedUrls.some((url) => url.includes("/HEAD/") || url.includes("/main/"))).toBe(
      false,
    );
    expect(
      resolved.entries.some(
        (entry) =>
          entry.path === "skills/vercel-react-best-practices/SKILL.md" &&
          new TextDecoder().decode(entry.content).includes("Trusted GitHub bytes."),
      ),
    ).toBe(true);
    expect(
      resolved.entries.some(
        (entry) =>
          entry.path === "skills/vercel-react-best-practices/guide.md" &&
          new TextDecoder().decode(entry.content) === "# Guide\n",
      ),
    ).toBe(true);
  });

  it("rejects skill downloads outside the owning GitHub raw path", async () => {
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "https://api.github.com/repos/anthropics/skills/commits/HEAD") {
        return Response.json({ sha: GITHUB_COMMIT });
      }
      if (url.includes("api.github.com/repos/anthropics/skills/contents/skills/frontend-design")) {
        return Response.json([
          {
            type: "file",
            name: "SKILL.md",
            path: "skills/frontend-design/SKILL.md",
            download_url: "https://evil.example/SKILL.md",
            size: 64,
          },
        ]);
      }
      return new Response("missing", { status: 404 });
    }) as typeof fetch;

    const marketplace = new SkillsShMarketplace({ fetch: fetchImpl, platform: "darwin" });
    await expect(
      marketplace.resolve({
        kind: "catalog",
        catalogId: SKILLS_SH_CATALOG_ID as never,
        entryId: FRONTEND_ENTRY_ID as never,
      }),
    ).rejects.toThrow(/not allowed/i);
  });

  it("cancels oversized skills.sh file streams at the file limit", async () => {
    let cancelled = false;
    let chunks = 0;
    const oversized = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(300 * 1024));
        chunks += 1;
        if (chunks === 4) controller.close();
      },
      cancel() {
        cancelled = true;
      },
    });
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "https://api.github.com/repos/anthropics/skills/commits/HEAD") {
        return Response.json({ sha: GITHUB_COMMIT });
      }
      if (url.includes("/contents/skills/frontend-design")) {
        return Response.json([
          {
            type: "file",
            name: "SKILL.md",
            path: "skills/frontend-design/SKILL.md",
            download_url:
              "https://raw.githubusercontent.com/anthropics/skills/main/skills/frontend-design/SKILL.md",
            size: 64,
          },
        ]);
      }
      if (url.startsWith("https://raw.githubusercontent.com/")) return new Response(oversized);
      return new Response("missing", { status: 404 });
    }) as typeof fetch;
    const marketplace = new SkillsShMarketplace({ fetch: fetchImpl, platform: "darwin" });

    await expect(
      marketplace.resolve({
        kind: "catalog",
        catalogId: SKILLS_SH_CATALOG_ID as never,
        entryId: FRONTEND_ENTRY_ID as never,
      }),
    ).rejects.toThrow(/size limits/i);
    expect(cancelled).toBe(true);
  });
});

describe("npm skill marketplace", () => {
  it("encodes package names reversibly for catalog entry ids", () => {
    expect(decodeNpmEntryId(encodeNpmEntryId("@demo/agent-skill"))).toBe("@demo/agent-skill");
    expect(decodeNpmEntryId(encodeNpmEntryId("example-agent-skill"))).toBe("example-agent-skill");
    const longName = "@octant-community/agent-productivity-review-tools";
    const compact = encodeNpmEntryId(longName);
    expect(compact.length).toBeLessThanOrEqual(96);
    expect(decodeNpmEntryId(compact)).toBe(longName);
  });

  it("extracts SKILL.md plus sibling support files and rejects host escapes", () => {
    const skill = `---
name: demo-skill
description: Demo skill for npm packages.
license: MIT
---
See [notes](notes.md)
`;
    const tarball = buildMinimalGzipTar([
      { path: "package/skills/demo-skill/SKILL.md", content: skill },
      { path: "package/skills/demo-skill/notes.md", content: "# Notes\n" },
    ]);
    expect(extractSkillMarkdownFromTarball(tarball)).toEqual([
      expect.objectContaining({
        directoryName: "demo-skill",
        extraFiles: [expect.objectContaining({ path: "notes.md" })],
      }),
    ]);
    expect(() =>
      extractSkillMarkdownFromTarball(
        buildMinimalGzipTar([{ path: "../escape/SKILL.md", content: skill }]),
      ),
    ).toThrow(/unsafe path/i);

    const rootTarball = buildMinimalGzipTar([
      { path: "SKILL.md", content: skill },
      { path: "scripts/run.js", content: "export default true;\n" },
      {
        path: "skills/other/SKILL.md",
        content: skill.replaceAll("demo-skill", "other-skill"),
      },
      { path: "skills/other/notes.md", content: "# Other notes\n" },
    ]);
    expect(extractSkillMarkdownFromTarball(rootTarball)[0]).toEqual(
      expect.objectContaining({
        directoryName: "skill",
        extraFiles: [expect.objectContaining({ path: "scripts/run.js" })],
      }),
    );
  });

  it("rejects duplicate normalized npm archive paths", () => {
    const skill = `---\nname: demo-skill\ndescription: Demo skill.\nlicense: MIT\n---\nBody\n`;
    expect(() =>
      extractSkillMarkdownFromTarball(
        buildMinimalGzipTar([
          { path: "package/skills/demo/SKILL.md", content: skill },
          { path: "package/skills/demo/SKILL.md", content: skill },
        ]),
      ),
    ).toThrow(/duplicate path/i);
  });

  it("rejects npm skills whose support-file closure exceeds the per-skill cap", () => {
    const skill = `---\nname: large-skill\ndescription: Large skill.\nlicense: MIT\n---\nBody\n`;
    const files = Array.from({ length: 65 }, (_, index) => ({
      path: `package/skills/large/reference-${index}.md`,
      content: `Reference ${index}\n`,
    }));
    expect(() =>
      extractSkillMarkdownFromTarball(
        buildMinimalGzipTar([{ path: "package/skills/large/SKILL.md", content: skill }, ...files]),
      ),
    ).toThrow(/support-file limit/i);
  });

  it("rejects npm skills with oversized support files instead of omitting them", () => {
    const skill = `---\nname: large-skill\ndescription: Large skill.\nlicense: MIT\n---\nBody\n`;
    expect(() =>
      extractSkillMarkdownFromTarball(
        buildMinimalGzipTar([
          { path: "package/skills/large/SKILL.md", content: skill },
          { path: "package/skills/large/reference.md", content: "x".repeat(512 * 1024 + 1) },
        ]),
      ),
    ).toThrow(/size limits/i);
  });

  it("verifies npm tarball integrity metadata", () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const integrity = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
    expect(() => verifyNpmTarballIntegrity(bytes, integrity, undefined)).not.toThrow();
    expect(() => verifyNpmTarballIntegrity(bytes, "sha512-AAAA", undefined)).toThrow(
      /integrity check failed/i,
    );
  });

  it("uses npm package license metadata when SKILL.md omits license", async () => {
    const skill = `---
name: demo-skill
description: Demo skill for npm packages.
---
Body
`;
    const tarball = buildMinimalGzipTar([
      { path: "package/skills/demo-skill/SKILL.md", content: skill },
    ]);
    const integrity = `sha512-${createHash("sha512").update(tarball).digest("base64")}`;
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/example-agent-skill")) {
        return Response.json({
          "dist-tags": { latest: "1.2.3" },
          versions: {
            "1.2.3": {
              license: "MIT",
              _npmUser: { name: "verified-publisher" },
              dist: {
                tarball:
                  "https://registry.npmjs.org/example-agent-skill/-/example-agent-skill-1.2.3.tgz",
                integrity,
              },
            },
          },
          author: { name: "spoofed-author" },
        });
      }
      if (url.endsWith(".tgz")) return new Response(tarball as unknown as BodyInit);
      return new Response("missing", { status: 404 });
    }) as typeof fetch;

    const marketplace = new NpmSkillMarketplace({ fetch: fetchImpl, platform: "darwin" });
    const resolved = await marketplace.resolve({
      kind: "catalog",
      catalogId: NPM_SKILLS_CATALOG_ID as never,
      entryId: encodeNpmEntryId("example-agent-skill") as never,
    });

    const inspected = inspectExtensionPackage(resolved);
    expect(inspected.manifest.license).toEqual({
      kind: "spdx",
      identifier: "MIT",
    });
    expect(inspected.manifest.provenance.publisher).toBe("verified-publisher");
  });

  it("uses SKILL.md license when npm package metadata omits it", async () => {
    const skill = `---
name: document-licensed
description: Document-licensed npm skill.
license: MIT
---
Body
`;
    const tarball = buildMinimalGzipTar([{ path: "package/SKILL.md", content: skill }]);
    const integrity = `sha512-${createHash("sha512").update(tarball).digest("base64")}`;
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/document-licensed")) {
        return Response.json({
          "dist-tags": { latest: "1.0.0" },
          versions: {
            "1.0.0": {
              _npmUser: { name: "verified" },
              dist: {
                tarball:
                  "https://registry.npmjs.org/document-licensed/-/document-licensed-1.0.0.tgz",
                integrity,
              },
            },
          },
        });
      }
      if (url.endsWith(".tgz")) return new Response(tarball as unknown as BodyInit);
      return new Response("missing", { status: 404 });
    }) as typeof fetch;
    const marketplace = new NpmSkillMarketplace({ fetch: fetchImpl, platform: "darwin" });

    const resolved = await marketplace.resolve({
      kind: "catalog",
      catalogId: NPM_SKILLS_CATALOG_ID as never,
      entryId: encodeNpmEntryId("document-licensed") as never,
    });

    expect(inspectExtensionPackage(resolved).manifest.license).toEqual({
      kind: "spdx",
      identifier: "MIT",
    });
  });

  it("searches npm and rejects packages without SKILL.md", async () => {
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/-/v1/search")) {
        return Response.json({
          objects: [
            {
              package: {
                name: "example-agent-skill",
                version: "1.2.3",
                description: "An agent skill package",
                publisher: { username: "demo" },
              },
            },
            {
              package: {
                name: "react-helper",
                version: "2.0.0",
                description: "Improve React workflows ",
                keywords: ["agent-skills"],
                publisher: { username: "verified" },
              },
            },
          ],
        });
      }
      if (url.endsWith("/example-agent-skill")) {
        return Response.json({
          "dist-tags": { latest: "1.2.3" },
          versions: {
            "1.2.3": {
              dist: {
                tarball:
                  "https://registry.npmjs.org/example-agent-skill/-/example-agent-skill-1.2.3.tgz",
                integrity:
                  "sha512-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==",
              },
            },
          },
          author: { name: "demo" },
        });
      }
      if (url.endsWith(".tgz")) {
        return new Response(new Uint8Array([0x1f, 0x8b, 0x08, 0x00]));
      }
      return new Response("missing", { status: 404 });
    }) as typeof fetch;

    const marketplace = new NpmSkillMarketplace({ fetch: fetchImpl, platform: "darwin" });
    const search = await marketplace.search("agent");
    expect(search.entries[0]?.source).toEqual({
      kind: "catalog",
      catalogId: NPM_SKILLS_CATALOG_ID,
      entryId: encodeNpmEntryId("example-agent-skill", "1.2.3"),
    });
    expect(search.entries.map((entry) => entry.displayName)).toContain("react-helper");
    expect(() =>
      decodeExtensionCommandResult({ kind: "skill-search-results", entries: search.entries }),
    ).not.toThrow();
    await expect(marketplace.resolve(search.entries[0]!.source)).rejects.toThrow();
  });

  it("resolves the exact npm version selected by search when latest moves", async () => {
    const selectedSkill = `---\nname: selected-skill\ndescription: Selected release.\nlicense: MIT\n---\nSelected instructions.\n`;
    const movedSkill = selectedSkill.replaceAll("Selected", "Moved");
    const selectedTarball = buildMinimalGzipTar([
      { path: "package/SKILL.md", content: selectedSkill },
    ]);
    const movedTarball = buildMinimalGzipTar([{ path: "package/SKILL.md", content: movedSkill }]);
    const selectedIntegrity = `sha512-${createHash("sha512").update(selectedTarball).digest("base64")}`;
    const movedIntegrity = `sha512-${createHash("sha512").update(movedTarball).digest("base64")}`;
    const marketplace = new NpmSkillMarketplace({
      fetch: (async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/-/v1/search")) {
          return Response.json({
            objects: [
              {
                package: {
                  name: "moving-skill",
                  version: "1.0.0",
                  publisher: { username: "example" },
                },
              },
            ],
          });
        }
        if (url.endsWith("/moving-skill")) {
          return Response.json({
            "dist-tags": { latest: "2.0.0" },
            versions: {
              "1.0.0": {
                _npmUser: { name: "example" },
                dist: {
                  tarball: "https://registry.npmjs.org/moving-skill/-/moving-skill-1.0.0.tgz",
                  integrity: selectedIntegrity,
                },
              },
              "2.0.0": {
                _npmUser: { name: "example" },
                dist: {
                  tarball: "https://registry.npmjs.org/moving-skill/-/moving-skill-2.0.0.tgz",
                  integrity: movedIntegrity,
                },
              },
            },
          });
        }
        if (url.endsWith("1.0.0.tgz")) return new Response(selectedTarball as unknown as BodyInit);
        if (url.endsWith("2.0.0.tgz")) return new Response(movedTarball as unknown as BodyInit);
        return new Response("missing", { status: 404 });
      }) as typeof fetch,
      platform: "darwin",
    });

    const [entry] = (await marketplace.search("moving")).entries;
    const resolved = await marketplace.resolve(entry!.source);
    const inspection = inspectExtensionPackage(resolved);
    expect(inspection.manifest.version).toBe("1.0.0");
    expect(inspection.manifest.components[0]).toMatchObject({ skillName: "selected-skill" });

    const moved = inspectExtensionPackage(
      await marketplace.resolve({
        kind: "catalog",
        catalogId: NPM_SKILLS_CATALOG_ID as never,
        entryId: encodeNpmEntryId("moving-skill", "2.0.0") as never,
      }),
    );
    expect(moved.manifest.version).toBe("2.0.0");
    expect(moved.manifest.extensionId).toBe(inspection.manifest.extensionId);
    expect(moved.manifest.packageId).toBe(inspection.manifest.packageId);
  });

  it("derives bounded provisional skill names for valid digit-prefixed npm packages", async () => {
    const marketplace = new NpmSkillMarketplace({
      fetch: (async () =>
        Response.json({
          objects: [
            {
              package: {
                name: "3d-agent-skill",
                version: "1.0.0",
                description: "Three-dimensional agent guidance",
                publisher: { username: "example" },
              },
            },
          ],
        })) as unknown as typeof fetch,
      platform: "darwin",
    });

    await expect(marketplace.search("3d")).resolves.toMatchObject({
      entries: [
        {
          skill: { name: "skill-3d-agent-skill" },
          displayName: "3d-agent-skill",
        },
      ],
    });
  });

  it("resolves each npm catalog result to exactly the skill shown in preview", async () => {
    const first = `---
name: first-skill
description: First skill.
license: MIT
---
First
`;
    const second = `---
name: second-skill
description: Second skill.
license: MIT
---
Second
`;
    const tarball = buildMinimalGzipTar([
      { path: "package/skills/first/SKILL.md", content: first },
      { path: "package/skills/second/SKILL.md", content: second },
    ]);
    const integrity = `sha512-${createHash("sha512").update(tarball).digest("base64")}`;
    const marketplace = new NpmSkillMarketplace({
      fetch: (async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith("/multi-skill-package")) {
          return Response.json({
            "dist-tags": { latest: "1.0.0" },
            versions: {
              "1.0.0": {
                _npmUser: { name: "example" },
                dist: {
                  tarball:
                    "https://registry.npmjs.org/multi-skill-package/-/multi-skill-package-1.0.0.tgz",
                  integrity,
                },
              },
            },
          });
        }
        if (url.endsWith(".tgz")) return new Response(tarball as unknown as BodyInit);
        return new Response("missing", { status: 404 });
      }) as typeof fetch,
      platform: "darwin",
    });

    const resolved = await marketplace.resolve({
      kind: "catalog",
      catalogId: NPM_SKILLS_CATALOG_ID as never,
      entryId: encodeNpmEntryId("multi-skill-package") as never,
    });
    const skillComponents = inspectExtensionPackage(resolved).manifest.components.filter(
      (component) => component.kind === "skill-instructions",
    );
    expect(skillComponents).toHaveLength(1);
    expect(skillComponents[0]).toMatchObject({ skillName: "first-skill" });
  });

  it("cancels oversized npm registry JSON responses before parsing", async () => {
    let searchCancelled = false;
    let metadataCancelled = false;
    const oversizedJson = (onCancel: () => void, declaredLength: boolean) => {
      let chunks = 0;
      return new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            controller.enqueue(new Uint8Array(1024 * 1024));
            chunks += 1;
            if (chunks === 10) controller.close();
          },
          cancel() {
            onCancel();
          },
        }),
        {
          headers: {
            "content-type": "application/json",
            ...(declaredLength ? { "content-length": String(9 * 1024 * 1024) } : {}),
          },
        },
      );
    };
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/-/v1/search")) {
        return oversizedJson(() => {
          searchCancelled = true;
        }, false);
      }
      if (url.endsWith("/oversized-metadata")) {
        return oversizedJson(() => {
          metadataCancelled = true;
        }, true);
      }
      return new Response("missing", { status: 404 });
    }) as typeof fetch;
    const marketplace = new NpmSkillMarketplace({ fetch: fetchImpl, platform: "darwin" });

    await expect(marketplace.search("agent")).rejects.toThrow(/size limits/i);
    expect(searchCancelled).toBe(true);
    await expect(
      marketplace.resolve({
        kind: "catalog",
        catalogId: NPM_SKILLS_CATALOG_ID as never,
        entryId: encodeNpmEntryId("oversized-metadata") as never,
      }),
    ).rejects.toThrow(/size limits/i);
    expect(metadataCancelled).toBe(true);
  });

  it("cancels npm tarball streams as soon as the compressed size limit is exceeded", async () => {
    let cancelled = false;
    let chunks = 0;
    const oversized = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(1024 * 1024));
        chunks += 1;
        if (chunks === 12) controller.close();
      },
      cancel() {
        cancelled = true;
      },
    });
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/oversized-skill")) {
        return Response.json({
          "dist-tags": { latest: "1.0.0" },
          versions: {
            "1.0.0": {
              license: "MIT",
              dist: {
                tarball: "https://registry.npmjs.org/oversized-skill/-/oversized-skill-1.0.0.tgz",
                integrity: "sha512-AA==",
              },
            },
          },
        });
      }
      if (url.endsWith(".tgz")) return new Response(oversized);
      return new Response("missing", { status: 404 });
    }) as typeof fetch;
    const marketplace = new NpmSkillMarketplace({ fetch: fetchImpl, platform: "darwin" });

    await expect(
      marketplace.resolve({
        kind: "catalog",
        catalogId: NPM_SKILLS_CATALOG_ID as never,
        entryId: encodeNpmEntryId("oversized-skill") as never,
      }),
    ).rejects.toThrow(/size limits/i);
    expect(cancelled).toBe(true);
  });
});

function buildMinimalGzipTar(
  files: ReadonlyArray<{ readonly path: string; readonly content: string }>,
): Uint8Array {
  const chunks: Buffer[] = [];
  for (const file of files) {
    const content = Buffer.from(file.content, "utf8");
    const header = Buffer.alloc(512, 0);
    header.write(file.path.slice(0, 100), 0, "utf8");
    header.write("0000644\0", 100, "utf8");
    header.write("0000000\0", 108, "utf8");
    header.write("0000000\0", 116, "utf8");
    header.write(`${content.byteLength.toString(8).padStart(11, "0")}\0`, 124, "utf8");
    header.write("00000000000\0", 136, "utf8");
    header.write("        ", 148, "utf8");
    header.write("0", 156, "utf8");
    header.write("ustar\0", 257, "utf8");
    header.write("00", 263, "utf8");
    let checksum = 0;
    for (const byte of header) checksum += byte;
    header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, "utf8");
    chunks.push(header);
    chunks.push(content);
    const padding = (512 - (content.byteLength % 512)) % 512;
    if (padding > 0) chunks.push(Buffer.alloc(padding, 0));
  }
  chunks.push(Buffer.alloc(1024, 0));
  return gzipSync(Buffer.concat(chunks));
}

describe("composite skill marketplace", () => {
  it("merges skills.sh and npm results and isolates source failures", async () => {
    const marketplace = createCompositeSkillMarketplace({
      skillsSh: {
        search: async () => ({
          entries: [
            {
              skill: {
                qualifiedId: `catalog:skills-sh~a:review:sha256:${"1".repeat(64)}` as never,
                name: "review" as never,
                sourceKind: "catalog",
                digest: `sha256:${"1".repeat(64)}` as never,
                available: true,
              },
              source: {
                kind: "catalog",
                catalogId: SKILLS_SH_CATALOG_ID as never,
                entryId: "a" as never,
              },
              version: "0.0.0" as never,
              displayName: "review",
              provenance: { reviewed: false },
            },
          ],
        }),
        resolve: async () => {
          throw new Error("unused");
        },
      },
      npm: {
        search: async () => {
          throw new Error("npm offline");
        },
        resolve: async () => {
          throw new Error("unused");
        },
      },
    });
    const result = await marketplace.search("review");
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]?.source).toMatchObject({ catalogId: SKILLS_SH_CATALOG_ID });
  });
});
