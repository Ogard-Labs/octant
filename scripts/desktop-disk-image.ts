/**
 * The macOS disk image for first install.
 *
 * The zip next to it stays the update artifact; this image is only what a
 * person downloads and opens. Its Finder window (background picture, icon
 * positions, no toolbar) comes from a prebuilt `.DS_Store` committed in
 * `scripts/dmg/`, so nothing here drives Finder or AppleScript. The template
 * refers to the background by volume name, which is why the name is fixed.
 *
 * What to run is decided here and tested; running is injected, as in
 * `sign-desktop.ts`.
 */

import { cp, mkdir, rm, symlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
  createNotarizationLogArgv,
  createNotarizeArgv,
  createStapleArgv,
  parseNotarizationSubmission,
  type CommandOutputRunner,
  type CommandRunner,
  type SigningCredentials,
} from "./sign-desktop";

/** The layout template names this volume in its background alias. */
export const DISK_IMAGE_VOLUME_NAME = "Octant";
/** The layout template positions this bundle name; Nightly's differs. */
export const DISK_IMAGE_APP_NAME = "Octant.app";
export const DISK_IMAGE_LAYOUT_DIRECTORY = "scripts/dmg";
const STAGING_DIRECTORY = ".dmg-staging";

export function diskImageFileName(productName: string, version: string): string {
  return `${productName}-${version}-darwin-arm64.dmg`;
}

export function createDiskImageArgv(input: {
  readonly stagingPath: string;
  readonly imagePath: string;
}): ReadonlyArray<string> {
  return [
    "/usr/bin/hdiutil",
    "create",
    "-volname",
    DISK_IMAGE_VOLUME_NAME,
    "-srcfolder",
    input.stagingPath,
    "-fs",
    "HFS+",
    "-format",
    "UDZO",
    // A rebuild replaces the image of the same name instead of failing.
    "-ov",
    input.imagePath,
  ];
}

/** Copies the bundle with `ditto`, which keeps symlinks, xattrs and the signature intact. */
export function createStageAppArgv(input: {
  readonly appPath: string;
  readonly stagedAppPath: string;
}): ReadonlyArray<string> {
  return ["/usr/bin/ditto", input.appPath, input.stagedAppPath];
}

export function createVerifyImageArgv(imagePath: string): ReadonlyArray<string> {
  return ["/usr/bin/hdiutil", "verify", imagePath];
}

/**
 * A disk image is a container, not code, so it gets no hardened-runtime flag
 * or entitlements; the timestamp is what notarization asks of it.
 */
export function createDiskImageCodesignArgv(input: {
  readonly identity: string;
  readonly imagePath: string;
}): ReadonlyArray<string> {
  return ["/usr/bin/codesign", "--force", "--timestamp", "--sign", input.identity, input.imagePath];
}

export type DiskImageOutcome =
  | { readonly kind: "built"; readonly imagePath: string; readonly signed: boolean }
  | { readonly kind: "skipped"; readonly reason: string };

/**
 * Whether this flavor gets a disk image. The Finder layout stores the app's
 * position under `Octant.app`, so a bundle with another name would sit at
 * Finder's default spot over the picture.
 */
export function diskImageSkipReason(appPath: string): string | undefined {
  return appPath.endsWith(`/${DISK_IMAGE_APP_NAME}`)
    ? undefined
    : `the disk image layout is made for ${DISK_IMAGE_APP_NAME}`;
}

/**
 * Builds the image from a finished app, then signs, notarizes and staples it
 * when credentials are given.
 *
 * The app inside is already signed and stapled by the time this runs, so the
 * image only needs its own signature and ticket: the notary service looks at
 * the container it is handed, and a stapled image opens without reaching
 * Apple. Without credentials the image is built unsigned, matching the app.
 */
export async function buildDesktopDiskImage(input: {
  readonly repositoryRoot: string;
  readonly appPath: string;
  readonly imagePath: string;
  readonly credentials: SigningCredentials | undefined;
  readonly run: CommandRunner;
  readonly runForOutput: CommandOutputRunner;
}): Promise<DiskImageOutcome> {
  const skipReason = diskImageSkipReason(input.appPath);
  if (skipReason !== undefined) return { kind: "skipped", reason: skipReason };

  const layout = resolve(input.repositoryRoot, DISK_IMAGE_LAYOUT_DIRECTORY);
  const stagingPath = join(dirname(input.imagePath), STAGING_DIRECTORY);
  await rm(stagingPath, { recursive: true, force: true });
  try {
    await mkdir(join(stagingPath, ".background"), { recursive: true });
    await input.run(
      createStageAppArgv({
        appPath: input.appPath,
        stagedAppPath: join(stagingPath, DISK_IMAGE_APP_NAME),
      }),
    );
    await symlink("/Applications", join(stagingPath, "Applications"));
    await cp(join(layout, "background.tiff"), join(stagingPath, ".background/background.tiff"));
    await cp(join(layout, "DS_Store.template"), join(stagingPath, ".DS_Store"));
    await input.run(createDiskImageArgv({ stagingPath, imagePath: input.imagePath }));
  } finally {
    await rm(stagingPath, { recursive: true, force: true });
  }
  await input.run(createVerifyImageArgv(input.imagePath));

  const credentials = input.credentials;
  if (credentials === undefined) {
    return { kind: "built", imagePath: input.imagePath, signed: false };
  }
  await input.run(
    createDiskImageCodesignArgv({ identity: credentials.identity, imagePath: input.imagePath }),
  );
  const notarization = await input.runForOutput(
    createNotarizeArgv({ archivePath: input.imagePath, notaryProfile: credentials.notaryProfile }),
  );
  const submission = parseNotarizationSubmission(notarization.stdout);
  if (notarization.exitCode !== 0 || submission.status !== "Accepted") {
    await input.run(
      createNotarizationLogArgv({
        submissionId: submission.id,
        notaryProfile: credentials.notaryProfile,
      }),
    );
    throw new Error(
      `Apple notarization returned ${submission.status} for the disk image, submission ${submission.id}.`,
    );
  }
  await input.run(createStapleArgv(input.imagePath));
  return { kind: "built", imagePath: input.imagePath, signed: true };
}
