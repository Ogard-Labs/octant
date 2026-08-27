import { constants } from "node:fs";
import { access } from "node:fs/promises";

export async function isExecutable(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
