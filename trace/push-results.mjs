// Record CI test results in Trace.Space as one Test Run per variant.
//
//   node trace/push-results.mjs [--dry-run] [sedan suv van]   (default: every results/*.json)
//
// Each test whose name starts with a Test Case ID (e.g. "TC-AR ...") becomes a test execution,
// pinned to the Test Case version the variant pins. Every step gets the test's result; a failure
// message goes into the last step's actual result. Test Case items are never written, so nothing
// goes suspect. Untagged tests are ignored; tags the org doesn't know are reported (the gate fails on them).
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { ROOT, TraceSpace } from "./lib/client.mjs";
import { loadOrg, loadVariant } from "./lib/org.mjs";
import { ciContext, testTag } from "./lib/ci.mjs";

const args = process.argv.slice(2);
const DRY = args.includes("--dry-run");
const wanted = args.filter((a) => !a.startsWith("--"));
const files = wanted.length
  ? wanted.map((v) => `${v}.json`)
  : readdirSync(`${ROOT}results`).filter((f) => /^(sedan|suv|van)\.json$/.test(f));
if (!files.length) {
  console.error("no results/*.json; run `npm test` first");
  process.exit(1);
}

const RESULT = { passed: "Passed", failed: "Failed", skipped: "Skipped" };
const ci = ciContext();
const ts = new TraceSpace();
const org = await loadOrg(ts);
const summary = [];

for (const f of files) {
  const path = `${ROOT}results/${f}`;
  if (!existsSync(path)) throw new Error(`missing ${path}`);
  const res = JSON.parse(readFileSync(path, "utf8"));
  const variant = await loadVariant(ts, org, res.variant);
  const cases = [];
  const unknown = [];
  for (const t of res.tests) {
    const tag = testTag(t.name);
    if (!tag) continue;
    const item = org.byDisplayId.get(tag);
    if (!item || item.typeName !== "Test Case") {
      unknown.push(tag);
      continue;
    }
    if (!variant.itemPins.has(item.id)) {
      console.log(`  - ${tag} is not in the ${variant.title} variant; skipped`);
      continue;
    }
    cases.push({ item, test: t, version: variant.itemPins.get(item.id) ?? item.version });
  }
  const name = `CI · ${variant.title} · ${ci.ref}@${ci.sha.slice(0, 7)}${ci.runNumber ? ` · #${ci.runNumber}` : ""}`;
  const counts = cases.reduce((m, c) => ({ ...m, [c.test.status]: (m[c.test.status] ?? 0) + 1 }), {});
  console.log(`${DRY ? "·" : "+"} ${name}: ${cases.length} test cases ${JSON.stringify(counts)}`);
  if (unknown.length) console.log(`  ! not Test Cases in the org: ${unknown.join(", ")}`);
  const row = { variant: variant.title, name, cases: cases.length, counts, unknown, runId: null };
  summary.push(row);
  if (DRY || !cases.length) continue;

  const id = randomUUID();
  await ts.post("/core/testRuns", {
    id,
    name,
    fields: {
      Variant: variant.title,
      Commit: ci.sha,
      Branch: ci.ref,
      "Build URL": ci.buildUrl ?? "local run",
      Source: "GitHub Actions",
    },
    testCasesUnderRun: cases.map((c) => ({ testCaseId: c.item.id, testCaseVersion: c.version })),
    isPubliclyVisible: true,
  });
  await ts.put(`/core/testRuns/${id}/start`);
  const executions = await ts.get(`/core/testRuns/${id}/executions`);
  for (const ex of executions) {
    const c = cases.find((x) => x.item.id === ex.testCaseId);
    const result = RESULT[c.test.status];
    if (!ex.steps.length) {
      await ts.put(`/core/testExecutions/${ex.id}/result`, { manualResult: result });
      continue;
    }
    for (const s of ex.steps) await ts.put(`/core/testExecutions/${ex.id}/steps/${s.stepId}/result`, { result });
    const last = ex.steps.at(-1).stepId;
    const actual = c.test.message ? `Failed in CI: ${c.test.message}` : `${c.test.name}: ${c.test.status} in ${c.test.durationMs} ms`;
    await ts.put(`/core/testExecutions/${ex.id}/steps/${last}/actualResult`, { actualResult: actual });
  }
  await ts.put(`/core/testRuns/${id}/end`);
  row.runId = id;
  console.log(`  run ${id}`);
}

writeFileSync(`${ROOT}results/push-summary.json`, `${JSON.stringify(summary, null, 2)}\n`);
