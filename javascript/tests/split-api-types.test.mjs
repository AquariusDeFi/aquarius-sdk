import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

test("typed find-path-split response composes with normalization and the builder", () => {
  execFileSync(
    process.execPath,
    [
      "node_modules/typescript/bin/tsc",
      "--noEmit",
      "--target",
      "ES2022",
      "--module",
      "NodeNext",
      "--moduleResolution",
      "NodeNext",
      "--strict",
      "--skipLibCheck",
      "tests/types/split-api.ts",
    ],
    { cwd: fileURLToPath(new URL("../", import.meta.url)), stdio: "pipe" },
  );
});
