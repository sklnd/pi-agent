/**
 * PATH lookup shared by the extensions. No pi imports, so it is testable with
 * plain node.
 */

import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";

/** True when a binary resolves on PATH (or is an absolute path). */
export function commandOnPath(name: string, env: NodeJS.ProcessEnv = process.env): boolean {
  if (name.includes("/")) {
    return existsSync(name);
  }
  return (env.PATH ?? "").split(delimiter).some((dir) => dir !== "" && existsSync(join(dir, name)));
}
