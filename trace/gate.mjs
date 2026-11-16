// Traceability gate: check the change and its test results against the Trace.Space org.
//
//   node trace/gate.mjs        writes results/gate.md (and the GitHub job summary); exit 1 on a "fail" finding
//
// Checks and their severity come from trace/policy.json.
import { execSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { ROOT, TraceSpace } from "./lib/client.mjs";
import { changeSet, idsIn, testTag } from "./lib/ci.mjs";
import { itemUrl, loadOrg, loadVariant } from "./lib/org.mjs";

const policy = JSON.parse(readFileSync(`${ROOT}trace/policy.json`, "utf8"));
const ts = new TraceSpace();
const org = await loadOrg(ts);
const orgId = await ts.orgId();
const { commits, pr } = changeSet();
const findings = []; // { check, level, text }
const link = (it) => {
  const url = itemUrl(ts, orgId, it);
  return url ? `[${it.displayId}](${url}) ${it.title}` : `**${it.displayId}** ${it.title}`;
};

function report(check, text) {
  const level = policy.checks[check] ?? "warn";
  if (level !== "off") findings.push({ check, level, text });
}

// ---------------------------------------------------------------- test results
const results = existsSync(`${ROOT}results`)
  ? readdirSync(`${ROOT}results`)
      .filter((f) => /^(sedan|suv|van)\.json$/.test(f))
      .map((f) => JSON.parse(readFileSync(`${ROOT}results/${f}`, "utf8")))
  : [];
const automated = new Map(); // TC display ID -> { variant: status }
for (const r of results) {
  for (const t of r.tests) {
    if (t.status === "failed") report("failing_tests", `\`${t.name}\` failed on ${r.variant}: ${t.message ?? ""}`.trim());
    const tag = testTag(t.name);
    if (!tag) continue;
    const item = org.byDisplayId.get(tag);
    if (!item || item.typeName !== "Test Case") {
      report("unknown_test_tags", `\`${t.name}\` is tagged ${tag}, which is not a Test Case in the org`);
      continue;
    }
    automated.set(tag, { ...(automated.get(tag) ?? {}), [r.variant]: t.status });
  }
}
if (!results.length) report("failing_tests", "no test results found (run `npm test` before the gate)");

// ---------------------------------------------------------------- suspect traces
for (const t of org.traces.filter(org.isSuspect)) {
  const ends = [...t.sources, ...t.targets].map((e) => org.byId.get(e.id)).filter(Boolean);
  report("suspect_traces", `${t.typeName} trace ${ends.map((e) => e.displayId).join(" → ")} is suspect`);
}

// ---------------------------------------------------------------- parameter drift
try {
  execSync("git diff --quiet -- config/", { cwd: ROOT, stdio: "ignore" });
} catch {
  report("param_drift", "parameter values in the org differ from the committed `config/params.*.json`; commit the refreshed files");
}

// ---------------------------------------------------------------- verification coverage per variant
const verifies = org.tracesOf(policy.trace_types.verification);
const testsOf = (req) =>
  verifies
    .filter((t) => t.sources.some((s) => s.id === req.id))
    .flatMap((t) => t.targets.map((e) => org.byId.get(e.id)))
    .filter((x) => x?.typeName === "Test Case");
const satisfies = org.tracesOf(policy.trace_types.satisfaction);
/** Test Cases behind an item: its own verifying tests, or those of the requirements a Design Element satisfies. */
const testsFor = (it) => {
  if (it.typeName === "Test Case") return [it];
  if (it.typeName === "Requirement") return testsOf(it);
  if (it.typeName === "Design Element") {
    return satisfies
      .filter((t) => t.targets.some((e) => e.id === it.id))
      .flatMap((t) => t.sources.map((e) => org.byId.get(e.id)))
      .filter((x) => x?.typeName === "Requirement")
      .flatMap(testsOf);
  }
  return [];
};
const coverage = [];
const unverified = new Map(); // REQ display ID -> variant titles
for (const v of org.variants) {
  const variant = await loadVariant(ts, org, v.title);
  for (const req of org.ofType("Requirement").filter((r) => variant.itemPins.has(r.id))) {
    const tests = testsOf(req).filter((tc) => variant.itemPins.has(tc.id));
    const auto = tests.filter((tc) => automated.get(tc.displayId)?.[v.title.toLowerCase()]);
    coverage.push({ variant: v.title, req, tests, auto });
    if (!tests.length && !policy.accepted_gaps[req.displayId]) {
      unverified.set(req.displayId, [...(unverified.get(req.displayId) ?? []), v.title]);
    }
  }
}
for (const [id, variants] of unverified) {
  report("unverified_requirements", `${link(org.byDisplayId.get(id))} has no verifying Test Case (${variants.join(", ")})`);
}

// ---------------------------------------------------------------- failed verification recorded in the org
for (const tc of org.ofType("Test Case")) {
  const r = tc.fields?.Result?.value?.[0];
  if (r === "Failed") report("failed_verification_in_org", `${link(tc)} is marked Failed in the org`);
}

// ---------------------------------------------------------------- architecture cross-check
if (existsSync(`${ROOT}results/crosscheck.json`)) {
  for (const f of JSON.parse(readFileSync(`${ROOT}results/crosscheck.json`, "utf8")).findings) report("architecture_drift", f.text);
}

// ---------------------------------------------------------------- IDs in the change
const text = [pr?.title, pr?.body, ...commits.map((c) => c.message)].join("\n");
const mentioned = idsIn(text);
for (const id of mentioned) {
  if (!org.byDisplayId.has(id)) report("untraced_ids_in_change", `\`${id}\` is mentioned in the change but is not an item in the org`);
}

// ---------------------------------------------------------------- report
const fails = findings.filter((f) => f.level === "fail");
const warns = findings.filter((f) => f.level === "warn");
const lines = [];
lines.push(`## Trace.Space traceability gate: ${fails.length ? "❌ failed" : "✅ passed"}`);
lines.push("");
lines.push(`${fails.length} blocking, ${warns.length} warnings · ${automated.size} Test Cases automated · ${results.length} variants tested`);
lines.push("");
if (mentioned.length) {
  lines.push("### Items this change mentions");
  lines.push("");
  lines.push("| Item | Verified by | Automated here |");
  lines.push("|---|---|---|");
  for (const id of mentioned) {
    const it = org.byDisplayId.get(id);
    if (!it) continue;
    const tests = [...new Set(testsFor(it))];
    const auto = tests.filter((tc) => automated.has(tc.displayId)).map((tc) => tc.displayId);
    lines.push(`| ${link(it)} | ${tests.map((t) => t.displayId).join(", ") || "—"} | ${auto.join(", ") || "—"} |`);
  }
  lines.push("");
}
for (const [title, list] of [["Blocking", fails], ["Warnings", warns]]) {
  if (!list.length) continue;
  lines.push(`### ${title}`);
  lines.push("");
  for (const f of list) lines.push(`- **${f.check}**: ${f.text}`);
  lines.push("");
}
lines.push("<details><summary>Verification coverage by variant</summary>");
lines.push("");
lines.push("| Variant | Requirement | Test Cases | Automated in CI |");
lines.push("|---|---|---|---|");
for (const c of coverage) {
  const gap = !c.tests.length ? (policy.accepted_gaps[c.req.displayId] ? "accepted gap" : "**none**") : c.tests.map((t) => t.displayId).join(", ");
  lines.push(`| ${c.variant} | ${link(c.req)} | ${gap} | ${c.auto.map((t) => t.displayId).join(", ") || "—"} |`);
}
lines.push("");
lines.push("</details>");
lines.push("");
lines.push("<!-- tracespace-gate -->");
const md = `${lines.join("\n")}\n`;
mkdirSync(`${ROOT}results`, { recursive: true });
writeFileSync(`${ROOT}results/gate.md`, md);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, md);
console.log(md);
process.exit(fails.length ? 1 : 0);
