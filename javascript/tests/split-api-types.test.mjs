import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

test("typed API response composes with split normalization", () => {
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
