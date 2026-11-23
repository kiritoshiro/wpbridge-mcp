import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// Runs the MEC helper's PHP regression harness (WordPress and MEC are stubbed;
// see test/php/mec-helper-harness.php). Skipped when PHP is not installed.
const harness = fileURLToPath(new URL("./php/mec-helper-harness.php", import.meta.url));
const php = spawnSync("php", ["-v"], { encoding: "utf8" });

test("MEC helper PHP regression harness passes", { skip: php.status !== 0 ? "php is not installed" : false }, () => {
  const run = spawnSync("php", [harness], { encoding: "utf8" });
  assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
  assert.match(run.stdout, /checks, 0 failed/);
});
