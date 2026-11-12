import { execFileSync } from "node:child_process";
import { renameSync } from "node:fs";

// Yarn Classic caches local tarballs by path, even after a package cache clean.
// A content-derived name makes every rebuilt package installable without stale code.
const [packed] = JSON.parse(execFileSync("npm", ["pack", "--ignore-scripts", "--json"], {
  encoding: "utf8",
}));
const filename = packed.filename.replace(/\.tgz$/, `-${packed.shasum.slice(0, 12)}.tgz`);
renameSync(packed.filename, filename);
console.log(filename);
