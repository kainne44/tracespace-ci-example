// Draw the architecture as Trace.Space describes it, and cross-check it against the code model.
//
//   node trace/diagrams.mjs [--png]
//
// Writes docs/architecture/tracespace-allocation.drawio with two pages:
//   1. Allocation: each Design Element with the requirements it satisfies, their verifying Test
//      Cases (green/red = automated here and passing/failing, gray = manual), the variants that
//      include it, and the code part that implements it. Every box links to the item.
//   2. Cross-check: where the org and the code model disagree.
// and results/crosscheck.json for the gate. The code side is model/autonomy-stack.model.json
// (checked and rendered to draw.io by tools/code-model.mjs); a part implements the Design Element named in its source file's
// header comment, e.g. "// Motion planner module (DES-AT): ...".
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { ROOT, TraceSpace } from "./lib/client.mjs";
import { testTag } from "./lib/ci.mjs";
import { itemUrl, loadOrg, loadVariant } from "./lib/org.mjs";

const policy = JSON.parse(readFileSync(`${ROOT}trace/policy.json`, "utf8"));
const MODEL = `${ROOT}model/autonomy-stack.model.json`;
const OUT = `${ROOT}docs/architecture`;

// ------------------------------------------------------------------ code side
const model = JSON.parse(readFileSync(MODEL, "utf8"));
const classifier = new Map(model.classifiers.map((c) => [c.name, c]));
const parts = [];
(function walk(list) {
  for (const p of list) {
    const c = classifier.get(p.type);
    if (c?.ports?.length) {
      const file = c.code?.split("#")[0];
      const head = file && existsSync(`${ROOT}${file}`) ? readFileSync(`${ROOT}${file}`, "utf8").split("\n").slice(0, 5).join("\n") : "";
      const des = /\b(DES-[A-Z]{1,4})\b/.exec(head)?.[1] ?? null;
      parts.push({ id: p.id, type: p.type, file, des });
    }
    if (p.children) walk(p.children);
  }
})(model.ibd.parts);

// ------------------------------------------------------------------ org side
const ts = new TraceSpace();
const org = await loadOrg(ts);
const orgId = await ts.orgId();
const variants = [];
for (const v of org.variants) variants.push(await loadVariant(ts, org, v.title));
variants.sort((a, b) => a.title.localeCompare(b.title));

const results = {};
if (existsSync(`${ROOT}results`)) {
  for (const f of readdirSync(`${ROOT}results`).filter((x) => /^(sedan|suv|van)\.json$/.test(x))) {
    for (const t of JSON.parse(readFileSync(`${ROOT}results/${f}`, "utf8")).tests) {
      const tag = testTag(t.name);
      if (!tag) continue;
      results[tag] = results[tag] === "failed" || t.status === "failed" ? "failed" : t.status;
    }
  }
}

const satisfies = org.tracesOf(policy.trace_types.satisfaction);
const verifies = org.tracesOf(policy.trace_types.verification);
const reqsOf = (des) =>
  satisfies
    .filter((t) => t.targets.some((e) => e.id === des.id))
    .flatMap((t) => t.sources.map((e) => org.byId.get(e.id)))
    .filter((x) => x?.typeName === "Requirement");
const testsOf = (req) =>
  verifies
    .filter((t) => t.sources.some((e) => e.id === req.id))
    .flatMap((t) => t.targets.map((e) => org.byId.get(e.id)))
    .filter((x) => x?.typeName === "Test Case");

const designElements = org.ofType("Design Element").sort((a, b) => a.displayId.localeCompare(b.displayId));

// ------------------------------------------------------------------ cross-check
const findings = [];
for (const p of parts) {
  if (!p.des) findings.push({ kind: "code_without_design_element", text: `Code part \`${p.id}\` (${p.file}) implements no Design Element` });
  else if (org.byDisplayId.get(p.des)?.typeName !== "Design Element")
    findings.push({ kind: "unknown_design_element", text: `Code part \`${p.id}\` names ${p.des}, which is not a Design Element in the org` });
}
for (const d of designElements) {
  if (!parts.some((p) => p.des === d.displayId))
    findings.push({ kind: "design_element_without_code", text: `${d.displayId} ${d.title} has no code part in the model` });
  if (!reqsOf(d).length) findings.push({ kind: "design_element_without_requirement", text: `${d.displayId} ${d.title} satisfies no requirement` });
}
// The van-only booster must only be wired into the van: compare variant membership with the code.
for (const p of parts.filter((x) => x.des)) {
  const d = org.byDisplayId.get(p.des);
  if (!d) continue;
  const inVariants = variants.filter((v) => v.itemPins.has(d.id)).map((v) => v.title);
  p.variants = inVariants;
}
mkdirSync(`${ROOT}results`, { recursive: true });
writeFileSync(`${ROOT}results/crosscheck.json`, `${JSON.stringify({ parts, findings }, null, 2)}\n`);

// ------------------------------------------------------------------ draw.io
const esc = (s) =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/\n/g, "&#10;");
let nextId = 2;
const cells = [];
function cell({ value = "", style, x, y, w, h, parent = "1", link, edge, source, target }) {
  const id = `c${nextId++}`;
  const geo = edge
    ? `<mxGeometry relative="1" as="geometry"/>`
    : `<mxGeometry x="${x}" y="${y}" width="${w}" height="${h}" as="geometry"/>`;
  const attrs = edge ? `edge="1" source="${source}" target="${target}"` : `vertex="1"`;
  const inner = `<mxCell id="${id}" style="${style}" ${attrs} parent="${parent}">${geo}</mxCell>`;
  cells.push(link ? `<UserObject id="${id}" label="${esc(value)}" link="${esc(link)}">${inner.replace(` id="${id}"`, "")}</UserObject>` : inner.replace(`style=`, `value="${esc(value)}" style=`));
  return id;
}
const COLORS = {
  passed: "fillColor=#d5e8d4;strokeColor=#82b366;",
  failed: "fillColor=#f8cecc;strokeColor=#b85450;",
  manual: "fillColor=#f5f5f5;strokeColor=#999999;fontColor=#555555;",
  missing: "fillColor=#fff2cc;strokeColor=#d6b656;",
};
const BASE = "rounded=1;whiteSpace=wrap;html=0;fontSize=11;arcSize=12;";

function page(name, build) {
  cells.length = 0;
  build();
  return `<diagram id="${esc(name.toLowerCase().replace(/\W+/g, "-"))}" name="${esc(name)}"><mxGraphModel grid="0" page="0"><root><mxCell id="0"/><mxCell id="1" parent="0"/>${cells.join("")}</root></mxGraphModel></diagram>`;
}

const CARD_W = 460;
const ROW_H = 30;
const COLS = 3;
const GAP = 40;

const allocation = page("Allocation (Trace.Space)", () => {
  cell({
    value:
      "Architecture as allocated in Trace.Space: each Design Element, the requirements it satisfies (Satisfaction) and the Test Cases that verify them (Verification).\n" +
      "Test chips: green = automated in CI and passing, red = automated and failing, gray = manual." + (ts.linksOn ? " Click any box to open the item." : ""),
    style: "text;html=0;whiteSpace=wrap;fontSize=12;fontColor=#555555;align=left;verticalAlign=top;",
    x: 0, y: 0, w: COLS * CARD_W + (COLS - 1) * GAP, h: 40,
  });
  const cards = [
    ...designElements.map((d) => ({ d, impl: parts.filter((p) => p.des === d.displayId) })),
    ...parts.filter((p) => !p.des).map((p) => ({ orphan: p })),
  ];
  const colY = Array(COLS).fill(70);
  for (const card of cards) {
    const col = colY.indexOf(Math.min(...colY));
    const x = col * (CARD_W + GAP);
    const y = colY[col];
    if (card.orphan) {
      const p = card.orphan;
      const h = 110;
      cell({
        value: `⚠ ${p.type} (code part "${p.id}")\n${p.file}\n\nNo Design Element in Trace.Space implements this module.\nAdd one and name it in the file's header comment.`,
        style: `${BASE}dashed=1;align=left;spacingLeft=10;verticalAlign=top;${COLORS.failed}`,
        x, y, w: CARD_W, h,
      });
      colY[col] += h + GAP;
      continue;
    }
    const { d, impl } = card;
    const reqs = reqsOf(d);
    const rows = reqs.map((r) => ({ r, tests: testsOf(r) }));
    const h = 78 + Math.max(1, rows.length) * (ROW_H + 6) + 10;
    const variantsOf = variants.filter((v) => v.itemPins.has(d.id)).map((v) => v.title);
    const implText = impl.length ? impl.map((p) => `${p.file} (${p.id})`).join(", ") : "⚠ no code part implements this element";
    const box = cell({
      value: "",
      style: `${BASE}verticalAlign=top;${impl.length ? "fillColor=#ffffff;strokeColor=#6c8ebf;" : COLORS.missing}`,
      x, y, w: CARD_W, h,
    });
    cell({
      value: `${d.displayId}  ${d.title}`,
      style: "text;html=0;fontStyle=1;fontSize=13;align=left;verticalAlign=top;",
      parent: box, x: 10, y: 6, w: CARD_W - 20, h: 20, link: itemUrl(ts, orgId, d),
    });
    cell({
      value: `Variants: ${variantsOf.join(", ") || "none"}\nCode: ${implText}`,
      style: "text;html=0;fontSize=10;fontColor=#555555;align=left;verticalAlign=top;whiteSpace=wrap;",
      parent: box, x: 10, y: 28, w: CARD_W - 20, h: 40,
    });
    let ry = 74;
    if (!rows.length) {
      cell({ value: "satisfies no requirement", style: `${BASE}${COLORS.missing}`, parent: box, x: 10, y: ry, w: CARD_W - 20, h: ROW_H });
    }
    for (const { r, tests } of rows) {
      const chipW = 62;
      const reqW = CARD_W - 20 - Math.max(1, tests.length) * (chipW + 4);
      cell({
        value: `${r.displayId}  ${r.title}`,
        style: `${BASE}align=left;spacingLeft=6;fillColor=#dae8fc;strokeColor=#6c8ebf;`,
        parent: box, x: 10, y: ry, w: reqW, h: ROW_H, link: itemUrl(ts, orgId, r),
      });
      let cx = 10 + reqW + 4;
      if (!tests.length) cell({ value: "no test", style: `${BASE}${COLORS.missing}`, parent: box, x: cx, y: ry, w: chipW, h: ROW_H });
      for (const tc of tests) {
        const status = results[tc.displayId] ?? "manual";
        const mark = status === "passed" ? " ✓" : status === "failed" ? " ✗" : "";
        cell({
          value: `${tc.displayId}${mark}`,
          style: `${BASE}${COLORS[status] ?? COLORS.manual}`,
          parent: box, x: cx, y: ry, w: chipW, h: ROW_H, link: itemUrl(ts, orgId, tc),
        });
        cx += chipW + 4;
      }
      ry += ROW_H + 6;
    }
    colY[col] += h + GAP;
  }
});

const crosscheck = page("Cross-check (code vs Trace.Space)", () => {
  const ok = !findings.length;
  cell({
    value: ok ? "✓ The code model and Trace.Space agree." : `${findings.length} disagreement${findings.length === 1 ? "" : "s"} between the code model and Trace.Space`,
    style: `text;html=0;fontStyle=1;fontSize=14;align=left;${ok ? "fontColor=#2d7600;" : "fontColor=#b85450;"}`,
    x: 0, y: 0, w: 900, h: 24,
  });
  let y = 40;
  cell({ value: "Code part", style: `${BASE}fontStyle=1;fillColor=#eeeeee;`, x: 0, y, w: 220, h: 28 });
  cell({ value: "Source", style: `${BASE}fontStyle=1;fillColor=#eeeeee;`, x: 224, y, w: 300, h: 28 });
  cell({ value: "Design Element", style: `${BASE}fontStyle=1;fillColor=#eeeeee;`, x: 528, y, w: 260, h: 28 });
  cell({ value: "Variants", style: `${BASE}fontStyle=1;fillColor=#eeeeee;`, x: 792, y, w: 160, h: 28 });
  for (const p of parts) {
    y += 32;
    const d = p.des ? org.byDisplayId.get(p.des) : null;
    const st = d ? COLORS.passed : COLORS.failed;
    cell({ value: `${p.id} : ${p.type}`, style: `${BASE}align=left;spacingLeft=6;${st}`, x: 0, y, w: 220, h: 28 });
    cell({ value: p.file ?? "", style: `${BASE}align=left;spacingLeft=6;${COLORS.manual}`, x: 224, y, w: 300, h: 28 });
    cell({
      value: d ? `${d.displayId}  ${d.title}` : "— none —",
      style: `${BASE}align=left;spacingLeft=6;${st}`,
      x: 528, y, w: 260, h: 28, link: d ? itemUrl(ts, orgId, d) : undefined,
    });
    cell({ value: (p.variants ?? []).join(", "), style: `${BASE}${COLORS.manual}`, x: 792, y, w: 160, h: 28 });
  }
  y += 50;
  for (const f of findings) {
    cell({ value: `⚠ ${f.text.replace(/`/g, "")}`, style: `${BASE}align=left;spacingLeft=8;${COLORS.missing}`, x: 0, y, w: 952, h: 28 });
    y += 32;
  }
});

mkdirSync(OUT, { recursive: true });
const file = `${OUT}/tracespace-allocation.drawio`;
writeFileSync(file, `<mxfile host="tracespace-ci-example">${allocation}${crosscheck}</mxfile>\n`);
console.log(`wrote ${file.replace(ROOT, "")}: ${designElements.length} Design Elements, ${parts.length} code parts, ${findings.length} findings`);
for (const f of findings) console.log(`  ! ${f.text}`);

if (process.argv.includes("--png")) {
  const drawio = process.env.DRAWIO || "drawio";
  mkdirSync(`${OUT}/diagrams`, { recursive: true });
  for (const [i, name] of [[1, "tracespace-allocation"], [2, "tracespace-crosscheck"]]) {
    execFileSync(drawio, ["-x", "-f", "png", "-s", "2", "-p", String(i), "-o", `${OUT}/diagrams/${name}.png`, file], { stdio: "ignore" });
  }
  console.log("PNGs written to docs/architecture/diagrams/");
}
