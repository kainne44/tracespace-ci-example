// Write config/params.<variant>.json from the parameter versions each Trace.Space variant pins.
//
//   node trace/pull-params.mjs [sedan suv van]     (default: every variant)
//   node trace/pull-params.mjs --check             fail if the committed files are out of date
//
// The files are committed, so tests also run offline; CI re-pulls them to test against the org.
import { readFileSync, writeFileSync } from "node:fs";
import { TraceSpace, ROOT } from "./lib/client.mjs";
import { loadOrg, loadVariant } from "./lib/org.mjs";

const args = process.argv.slice(2);
const CHECK = args.includes("--check");
const wanted = args.filter((a) => !a.startsWith("--"));

const ts = new TraceSpace();
const org = await loadOrg(ts);
const variants = wanted.length ? wanted : org.variants.map((v) => v.title.toLowerCase());
const catalog = await ts.get("/core/parameters/catalog");
const params = Array.isArray(catalog) ? catalog : catalog.parameters ?? catalog.items ?? [];
const historyCache = new Map();

async function valueAt(paramId, version) {
  if (!historyCache.has(paramId)) historyCache.set(paramId, await ts.get(`/core/parameters/catalog/${paramId}/versions`));
  const hit = historyCache.get(paramId).find((h) => h.version === version);
  if (!hit) throw new Error(`parameter ${paramId} has no version ${version}`);
  return hit.payload;
}

let stale = 0;
for (const name of variants) {
  const v = await loadVariant(ts, org, name);
  const out = { variant: name, source: { variantId: v.id, title: v.title }, parameters: {} };
  for (const p of params.sort((a, b) => a.name.localeCompare(b.name))) {
    const version = v.paramPins.get(p.id) ?? p.version;
    const payload = await valueAt(p.id, version);
    out.parameters[p.name] = { value: payload.value, unit: payload.unit ?? "", version, id: p.id };
  }
  const path = `${ROOT}config/params.${name}.json`;
  const text = `${JSON.stringify(out, null, 2)}\n`;
  let old = "";
  try {
    old = readFileSync(path, "utf8");
  } catch {
    // first pull
  }
  if (old === text) {
    console.log(`= ${name}: up to date`);
    continue;
  }
  stale++;
  if (CHECK) {
    console.log(`! ${name}: out of date with the org`);
  } else {
    writeFileSync(path, text);
    console.log(`+ ${name}: ${Object.keys(out.parameters).length} parameters written`);
  }
}
if (CHECK && stale) process.exit(1);
