// Run the test suite for one variant (VARIANT=sedan|suv|van, default sedan), printing a spec
// report and writing results/<variant>.json for trace/push-results.mjs.
//   node trace/run-tests.mjs [--all]     --all runs every variant
import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { ROOT } from "./lib/client.mjs";

const variants = process.argv.includes("--all") ? ["sedan", "suv", "van"] : [process.env.VARIANT ?? "sedan"];
mkdirSync(`${ROOT}results`, { recursive: true });
let failed = false;
for (const variant of variants) {
  console.log(`\n== ${variant} ==`);
  const r = spawnSync(
    process.execPath,
    [
      "--test",
      "--test-reporter=spec",
      "--test-reporter-destination=stdout",
      `--test-reporter=${ROOT}trace/reporter.mjs`,
      `--test-reporter-destination=${ROOT}results/${variant}.json`,
      "test/**/*.test.ts",
    ],
    { cwd: ROOT, stdio: "inherit", env: { ...process.env, VARIANT: variant } },
  );
  failed ||= r.status !== 0;
}
process.exit(failed ? 1 : 0);
