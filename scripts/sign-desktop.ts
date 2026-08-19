/**
 * Developer ID signing, hardened runtime, and notarization.
 *
 * Signing is not a finishing touch on the packaged app: per
 * `docs/decisions/0032` it is a prerequisite of the updater, because Squirrel
 * checks a replacement against the running app's designated requirement and an
 * unsigned app has none to check against. So this runs inside the packaging
 * pipeline, and a release build that cannot sign fails rather than emitting
 * something that looks shippable.
 *
 * The credentials live with the maintainer. Everything here that decides *what*
 * to run is pure and tested; the running itself is injected, so the pipeline is
 * exercised on hosts that hold no certificate.
 */

import { resolve } from "node:path";

export const ENTITLEMENTS_PATH = "apps/desktop/resources/entitlements.plist";

/** Signed innermost-first: a bundle's seal covers what is already inside it. */
export const SIGNING_ORDER = [
  "Contents/Resources/native/octant-keychain-helper",
  "Contents/Resources/native/octant-code-file-helper",
  "Contents/Resources/app/apps/server/node_modules/better-sqlite3/build/Release/better_sqlite3.node",
  "Contents/Resources/app/apps/server/node_modules/node-pty/build/Release/pty.node",
  "Contents/Resources/app/apps/server/node_modules/node-pty/build/Release/spawn-helper",
  "Contents/Frameworks/Electron Framework.framework/Versions/A/Libraries/libEGL.dylib",
  "Contents/Frameworks/Electron Framework.framework/Versions/A/Libraries/libGLESv2.dylib",
  "Contents/Frameworks/Electron Framework.framework/Versions/A/Libraries/libffmpeg.dylib",
  "Contents/Frameworks/Electron Framework.framework/Versions/A/Libraries/libvk_swiftshader.dylib",
  "Contents/Frameworks/Electron Framework.framework",
  "Contents/Frameworks/Octant Helper.app",
  "Contents/Frameworks/Octant Helper (GPU).app",
  "Contents/Frameworks/Octant Helper (Plugin).app",
  "Contents/Frameworks/Octant Helper (Renderer).app",
] as const;

export interface SigningCredentials {
  /** The Developer ID Application identity, as `security find-identity` names it. */
  readonly identity: string;
  /** A `notarytool` keychain profile the maintainer stored ahead of time. */
  readonly notaryProfile: string;
  readonly teamId: string;
}

export type SigningCredentialsResolution =
  | { readonly kind: "available"; readonly credentials: SigningCredentials }
  | { readonly kind: "absent"; readonly missing: ReadonlyArray<string> };

export const SIGNING_ENVIRONMENT_VARIABLES = [
  "OCTANT_SIGNING_IDENTITY",
  "OCTANT_NOTARY_PROFILE",
  "OCTANT_SIGNING_TEAM_ID",
] as const;

/**
 * Read signing credentials from the environment, reporting exactly what is
 * missing.
 *
 * Absent is a first-class answer rather than an error: a contributor packaging
 * locally has no certificate and should still get a working app, as long as
 * nobody can mistake it for a release. What turns absence into a failure is
 * `requireSigned`, not this.
 */
export function resolveSigningCredentials(
  environment: Record<string, string | undefined>,
): SigningCredentialsResolution {
  const read = (name: string): string => (environment[name] ?? "").trim();
  const missing = SIGNING_ENVIRONMENT_VARIABLES.filter((name) => read(name) === "");
  if (missing.length > 0) return { kind: "absent", missing };
  return {
    kind: "available",
    credentials: {
      identity: read("OCTANT_SIGNING_IDENTITY"),
      notaryProfile: read("OCTANT_NOTARY_PROFILE"),
      teamId: read("OCTANT_SIGNING_TEAM_ID"),
    },
  };
}

/**
 * Whether this build must be signed.
 *
 * A release is declared, never inferred. Inferring it from "credentials happen
 * to be present" would mean a release quietly became unsigned the day a secret
 * failed to load, which is exactly the failure this flag exists to make loud.
 */
export function requireSigned(environment: Record<string, string | undefined>): boolean {
  return (environment.OCTANT_RELEASE_BUILD ?? "").trim() === "1";
}

export function createCodesignArgv(input: {
  readonly identity: string;
  readonly target: string;
  readonly entitlements: string;
}): ReadonlyArray<string> {
  return [
    "/usr/bin/codesign",
    "--force",
    // Hardened runtime is what notarization requires and what makes the
    // entitlements below meaningful rather than advisory.
    "--options",
    "runtime",
    "--timestamp",
    "--entitlements",
    input.entitlements,
    "--sign",
    input.identity,
    input.target,
  ];
}

/** Verify what was signed, rather than trusting that `codesign` exited zero. */
export function createVerifyArgv(target: string): ReadonlyArray<string> {
  return ["/usr/bin/codesign", "--verify", "--deep", "--strict", "--verbose=2", target];
}

export function createNotarizeArgv(input: {
  readonly archivePath: string;
  readonly notaryProfile: string;
}): ReadonlyArray<string> {
  return [
    "/usr/bin/xcrun",
    "notarytool",
    "submit",
    input.archivePath,
    "--keychain-profile",
    input.notaryProfile,
    // Without this the pipeline would report success while the submission was
    // still in a queue, and staple a ticket that does not exist yet.
    "--wait",
  ];
}

export function createStapleArgv(appPath: string): ReadonlyArray<string> {
  return ["/usr/bin/xcrun", "stapler", "staple", appPath];
}

/** Zip preserving symlinks and metadata, which a plain `zip` would flatten. */
export function createArchiveArgv(input: {
  readonly appPath: string;
  readonly archivePath: string;
}): ReadonlyArray<string> {
  return [
    "/usr/bin/ditto",
    "-c",
    "-k",
    "--keepParent",
    "--sequesterRsrc",
    input.appPath,
    input.archivePath,
  ];
}

export type CommandRunner = (argv: ReadonlyArray<string>) => Promise<void>;

/**
 * Sign every nested payload, then the bundle, then notarize and staple.
 *
 * The order is the point: `codesign` seals a bundle including whatever is
 * inside it, so a nested binary signed afterwards invalidates the outer seal.
 * Verification runs against the finished bundle rather than being assumed from
 * exit codes.
 */
export async function signAndNotarizeDesktop(input: {
  readonly repositoryRoot: string;
  readonly appPath: string;
  readonly archivePath: string;
  readonly credentials: SigningCredentials;
  readonly run: CommandRunner;
}): Promise<void> {
  const entitlements = resolve(input.repositoryRoot, ENTITLEMENTS_PATH);
  for (const relativePath of SIGNING_ORDER) {
    await input.run(
      createCodesignArgv({
        identity: input.credentials.identity,
        target: `${input.appPath}/${relativePath}`,
        entitlements,
      }),
    );
  }
  await input.run(
    createCodesignArgv({
      identity: input.credentials.identity,
      target: input.appPath,
      entitlements,
    }),
  );
  await input.run(createVerifyArgv(input.appPath));
  await input.run(createArchiveArgv({ appPath: input.appPath, archivePath: input.archivePath }));
  await input.run(
    createNotarizeArgv({
      archivePath: input.archivePath,
      notaryProfile: input.credentials.notaryProfile,
    }),
  );
  await input.run(createStapleArgv(input.appPath));
}
