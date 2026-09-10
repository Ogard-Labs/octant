import { cp, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  BUNDLED_CUA_DRIVER,
  stageComputerDriver,
  verifyComputerDriverBinary,
} from "../apps/desktop/src/computerUseDriverRelease";

/** Build-time dependency acquisition; end users receive the verified executable in the app. */
export async function prepareComputerUseDriver(
  repositoryRoot: string,
  destination: string,
): Promise<void> {
  if (process.platform !== "darwin") return;
  const staged = await stageComputerDriver(
    BUNDLED_CUA_DRIVER,
    resolve(repositoryRoot, ".computer-use-driver"),
    AbortSignal.timeout(180_000),
  );
  await mkdir(dirname(destination), { recursive: true });
  await cp(staged.path, destination);
  await verifyComputerDriverBinary(destination, BUNDLED_CUA_DRIVER.version);
}

if (import.meta.main) {
  const root = resolve(import.meta.dirname, "..");
  await prepareComputerUseDriver(root, resolve(root, "apps/desktop/dist/native/cua-driver"));
}
