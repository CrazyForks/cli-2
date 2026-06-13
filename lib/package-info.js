import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const CLI_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function readCliPackageJson() {
  return JSON.parse(readFileSync(path.join(CLI_ROOT, "package.json"), "utf8"));
}

export function currentCliVersion() {
  return readCliPackageJson().version;
}
