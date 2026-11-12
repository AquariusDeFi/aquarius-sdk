import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

test("Git installation exposes the same package and dependencies as the npm release", () => {
  const root = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
  const published = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  for (const key of ["name", "version", "type", "engines", "peerDependencies", "dependencies", "devDependencies"])
    assert.deepEqual(root[key], published[key], `${key} must match the JavaScript package`);
  assert.equal(root.private, true, "npm releases must still come from javascript/");
  assert.equal(root.main, `javascript/${published.main}`);
  assert.equal(root.types, `javascript/${published.types}`);
});
