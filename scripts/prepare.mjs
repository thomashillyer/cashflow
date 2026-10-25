// npm "prepare": enable the repo's pre-push hook (blocks pushes to main) by setting core.hooksPath to scripts/hooks.
// Shell-neutral and never fails the install: skips when there is no .git (e.g. a packed install), when git is missing,
// or when core.hooksPath is already set to something else (husky or personal hooks are left alone).

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const HOOKS = "scripts/hooks";

try {
  if (existsSync(join(root, ".git"))) {
    let current = "";
    try {
      current = execFileSync("git", ["config", "--get", "core.hooksPath"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    } catch {
      // Exit code 1 means unset; anything else (git missing) is caught by the outer call below.
    }
    if (current && current !== HOOKS) {
      console.log(`prepare: core.hooksPath is already "${current}"; leaving it. Run "git config core.hooksPath ${HOOKS}" to enable the pre-push hook.`);
    } else if (!current) {
      execFileSync("git", ["config", "core.hooksPath", HOOKS], { cwd: root, stdio: "ignore" });
    }
  }
} catch {
  // Never fail npm install over a git hook.
}
