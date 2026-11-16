#!/usr/bin/env node
// code-model: keep an architecture diagram honest by checking it against the code, then draw it.
//
//   node tools/code-model.mjs check  <model.json>
//   node tools/code-model.mjs render <model.json> --out <dir> [--png] [--tracespace]
//
// The model (model/autonomy-stack.model.json) describes the code's structure as data:
//   items       data types that cross module boundaries: fields ("name: Type") or enum values
//   portTypes   interfaces between parts: the operations a provider offers
//   classifiers the classes that become parts: their ports (T = provides T, ~T = calls T) and operations
//   ibd         the internal block diagram: parts (instances of classifiers) and connectors between ports
//   activities  behaviors as flows of actions: calls through a port, or the part's own operations
// Types are String, Integer, Real, Boolean or a model name, with [*] for many and ? for optional.
// "code": "src/file.ts#Symbol" ties an element to the code.
//
// check   verifies the model is consistent (every reference resolves, connectors join T to ~T,
//         activities call operations the port really offers) and that it matches the code: the
//         symbols exist, item fields and enum values match, interfaces have the operations with the
//         same parameters and result, classes implement the ports they provide and hold a reference
//         to the ports they call. Exit code 1 on any error, so CI fails when model and code drift.
// render  writes <dir>/<model name>.drawio: the IBD, the interfaces, and one page per activity, all
//         cross-linked. Each part is labeled with the Trace.Space Design Element named in its source
//         file's header comment (e.g. "// Motion planner module (DES-AT): ..."); with --tracespace,
//         credentials and links on (see trace/lib/client.mjs) the label links to the item. --png also writes
//         <dir>/diagrams/<page>.png with the draw.io desktop CLI (set DRAWIO to its binary).
//
// Layout is deliberately simple: parts and actions are placed in rows by dependency depth and
// draw.io routes the connectors. Open the .drawio file to rearrange; regenerate to reset.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import ts from "typescript";

const [command, modelArg, ...rest] = process.argv.slice(2);
if (!["check", "render"].includes(command) || !modelArg) {
  console.error("usage: code-model.mjs check <model.json> | render <model.json> --out <dir> [--png] [--tracespace]");
  process.exit(2);
}
const flag = (name) => rest.includes(name);
const option = (name) => (rest.includes(name) ? rest[rest.indexOf(name) + 1] : undefined);

const modelPath = resolve(modelArg);
const model = JSON.parse(readFileSync(modelPath, "utf8"));
// Code paths are relative to the project root: the nearest directory above the model with a package.json.
let root = dirname(modelPath);
while (!existsSync(join(root, "package.json")) && dirname(root) !== root) root = dirname(root);

for (const key of ["items", "portTypes", "classifiers", "activities"]) model[key] ??= [];
model.ibd ??= { parts: [], connectors: [] };

// ---------------------------------------------------------------- model vocabulary
const BUILTIN = { String: "string", Integer: "number", Real: "number", Boolean: "boolean" };
const byName = new Map();
for (const kind of ["items", "portTypes", "classifiers"]) for (const e of model[kind]) byName.set(e.name, { kind, e });
const portType = (name) => model.portTypes.find((p) => p.name === name);
const classifier = (name) => model.classifiers.find((c) => c.name === name);

/** "SensorHealth[*]?" -> { name: "SensorHealth", many: true, optional: true } */
function parseType(text) {
  const t = text.trim();
  const optional = t.endsWith("?");
  const core = optional ? t.slice(0, -1) : t;
  const many = core.endsWith("[*]");
  return { name: many ? core.slice(0, -3) : core, many, optional };
}
/** "label: ObjectClass?" -> { name: "label", type: {...} } */
function parseField(text) {
  const i = text.indexOf(":");
  return { name: text.slice(0, i).trim(), type: parseType(text.slice(i + 1)) };
}
const fmtOp = (op) => `${op.name}(${(op.params ?? []).join(", ")})${op.result ? `: ${op.result}` : ""}`;

/** Every part of the IBD, depth first, with its parent. */
function allParts() {
  const out = [];
  (function walk(list, parent) {
    for (const p of list) {
      out.push({ ...p, parent });
      if (p.children) walk(p.children, p);
    }
  })(model.ibd.parts, null);
  return out;
}

// ---------------------------------------------------------------- code index (syntax only)
const sources = new Map();
/** Exported declarations of a file: interfaces, classes, type aliases, functions. */
function indexFile(file) {
  if (sources.has(file)) return sources.get(file);
  const path = join(root, file);
  const decls = new Map();
  if (existsSync(path)) {
    const sf = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true);
    const text = (node) => (node ? node.getText(sf) : "");
    const exported = (n) => n.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
    const param = (p) => ({ name: text(p.name), type: text(p.type), optional: !!p.questionToken || !!p.initializer });
    const members = (list) => {
      const props = new Map();
      const methods = new Map();
      for (const m of list) {
        const name = m.name ? text(m.name) : "";
        if (ts.isPropertySignature(m) || ts.isPropertyDeclaration(m)) props.set(name, { type: text(m.type), optional: !!m.questionToken });
        if (ts.isMethodSignature(m) || ts.isMethodDeclaration(m)) methods.set(name, { params: m.parameters.map(param), result: text(m.type) });
        if (ts.isConstructorDeclaration(m)) for (const p of m.parameters) props.set(text(p.name), { type: text(p.type), optional: !!p.questionToken });
      }
      return { props, methods };
    };
    for (const s of sf.statements) {
      if (!exported(s)) continue;
      if (ts.isInterfaceDeclaration(s)) decls.set(s.name.text, { kind: "interface", ...members(s.members) });
      else if (ts.isClassDeclaration(s) && s.name) {
        const implementsNames = (s.heritageClauses ?? [])
          .filter((h) => h.token === ts.SyntaxKind.ImplementsKeyword)
          .flatMap((h) => h.types.map((t) => text(t.expression)));
        decls.set(s.name.text, { kind: "class", implements: implementsNames, ...members(s.members) });
      } else if (ts.isTypeAliasDeclaration(s)) {
        const values = ts.isUnionTypeNode(s.type) && s.type.types.every((t) => ts.isLiteralTypeNode(t) && ts.isStringLiteral(t.literal))
          ? s.type.types.map((t) => t.literal.text)
          : null;
        decls.set(s.name.text, { kind: "type", values, ...(ts.isTypeLiteralNode(s.type) ? members(s.type.members) : {}) });
      } else if (ts.isFunctionDeclaration(s) && s.name) decls.set(s.name.text, { kind: "function" });
    }
  }
  const entry = { exists: existsSync(path), decls };
  sources.set(file, entry);
  return entry;
}
function resolveRef(ref) {
  const [file, symbol] = ref.split("#");
  const f = indexFile(file);
  return { file, symbol, exists: f.exists, decl: f.decls.get(symbol) };
}

/** A code type's text, normalized for comparison: no spaces, readonly, Array<T> -> T[], no "| undefined". */
function normCode(text) {
  let t = text.replace(/\s+/g, "").replace(/readonly/g, "");
  t = t.replace(/^Array<(.+)>$/, "$1[]").replace(/^ReadonlyArray<(.+)>$/, "$1[]");
  const optional = /\|undefined$/.test(t);
  t = t.replace(/\|undefined$/, "");
  return { text: t, optional };
}
/** What a model type should look like in TypeScript. */
const expectCode = (type) => `${BUILTIN[type.name] ?? type.name}${type.many ? "[]" : ""}`;
function typeMismatch(modelText, codeText) {
  const want = parseType(modelText);
  const got = normCode(codeText);
  return got.text === expectCode(want) ? null : `model says ${modelText}, code says ${codeText || "(untyped)"}`;
}

// ---------------------------------------------------------------- check
function check() {
  const errors = [];
  const warnings = [];
  const err = (where, msg) => errors.push(`${where}: ${msg}`);
  let checked = 0;

  // Model consistency
  const known = (t) => {
    const { name } = parseType(t);
    return name in BUILTIN || byName.has(name);
  };
  const seen = new Set();
  for (const kind of ["items", "portTypes", "classifiers"]) {
    for (const e of model[kind]) {
      if (seen.has(e.name)) err(e.name, "defined twice");
      seen.add(e.name);
    }
  }
  for (const it of model.items) for (const f of it.fields ?? []) if (!known(parseField(f).type.name)) err(`${it.name}.${parseField(f).name}`, `unknown type ${parseField(f).type.name}`);
  const checkOp = (where, op) => {
    for (const p of op.params ?? []) if (!known(parseField(p).type.name)) err(`${where}.${op.name}`, `unknown parameter type in "${p}"`);
    if (op.result && !known(op.result)) err(`${where}.${op.name}`, `unknown result type ${op.result}`);
  };
  for (const pt of model.portTypes) for (const op of pt.provides ?? []) checkOp(pt.name, op);
  for (const c of model.classifiers) {
    for (const port of c.ports ?? []) if (!portType(port.type.replace(/^~/, ""))) err(`${c.name}.${port.name}`, `unknown port type ${port.type}`);
    for (const op of c.operations ?? []) checkOp(c.name, op);
    if (c.behavior && !model.activities.some((a) => a.name === c.behavior)) err(c.name, `behavior "${c.behavior}" is not an activity`);
  }
  const parts = allParts();
  const partById = new Map(parts.map((p) => [p.id, p]));
  for (const p of parts) if (!classifier(p.type)) err(`part ${p.id}`, `unknown classifier ${p.type}`);
  const portOf = (end) => {
    const [pid, pname] = end.split(".");
    const part = partById.get(pid);
    return part && classifier(part.type)?.ports?.find((x) => x.name === pname);
  };
  for (const c of model.ibd.connectors) {
    const a = portOf(c.from);
    const b = portOf(c.to);
    if (!a || !b) {
      err(`connector ${c.from} -> ${c.to}`, `no port ${!a ? c.from : c.to}`);
      continue;
    }
    const conj = (x, y) => x.type === `~${y.type}` || y.type === `~${x.type}`;
    if (!conj(a, b)) err(`connector ${c.from} -> ${c.to}`, `joins ${a.type} to ${b.type}; one end must be T and the other ~T`);
    checked++;
  }
  for (const act of model.activities) {
    const where = `activity "${act.name}"`;
    const of = classifier(act.of);
    if (!of) err(where, `unknown classifier ${act.of}`);
    const ids = new Set(act.nodes.map((n) => n.id));
    if (act.nodes.filter((n) => n.kind === "initial").length !== 1) err(where, "needs exactly one initial node");
    if (!act.nodes.some((n) => n.kind === "final")) err(where, "needs a final node");
    for (const f of act.flows) if (!ids.has(f.from) || !ids.has(f.to)) err(where, `flow ${f.from} -> ${f.to} names a missing node`);
    for (const n of act.nodes.filter((x) => x.kind === "action")) {
      const owner = classifier(n.owner);
      if (!owner) {
        err(`${where} ${n.id}`, `unknown owner ${n.owner}`);
        continue;
      }
      if (n.via) {
        const port = of?.ports?.find((p) => p.name === n.via);
        const T = port?.type.replace(/^~/, "");
        if (!port) err(`${where} ${n.id}`, `${act.of} has no port "${n.via}"`);
        else if (!owner.ports?.some((p) => p.type === T)) err(`${where} ${n.id}`, `${n.owner} does not provide ${T}`);
        else if (!portType(T)?.provides?.some((op) => op.name === n.name)) err(`${where} ${n.id}`, `${T} has no operation ${n.name}()`);
      } else if (!owner.operations?.some((op) => op.name === n.name)) err(`${where} ${n.id}`, `${n.owner} has no operation ${n.name}()`);
      checked++;
    }
    const reach = new Set([act.nodes.find((n) => n.kind === "initial")?.id]);
    for (let grew = true; grew; ) {
      grew = false;
      for (const f of act.flows) if (reach.has(f.from) && !reach.has(f.to)) grew = reach.add(f.to);
    }
    for (const n of act.nodes) if (!reach.has(n.id)) err(`${where} ${n.id}`, "unreachable from the initial node");
  }

  // Conformance to the code
  const opMatches = (where, op, m, { signature }) => {
    if (!m) return err(where, `no method ${op.name}() in the code`);
    const want = (op.params ?? []).map(parseField);
    const got = m.params.filter((p) => !p.optional || want.some((w) => w.name === p.name));
    if (want.map((w) => w.name).join(",") !== got.map((p) => p.name).join(","))
      return err(where, `parameters: model (${want.map((w) => w.name).join(", ")}), code (${m.params.map((p) => p.name).join(", ")})`);
    if (!signature) return;
    want.forEach((w, i) => {
      const bad = typeMismatch(`${w.type.name}${w.type.many ? "[*]" : ""}`, got[i].type);
      if (bad) err(`${where}(${w.name})`, bad);
    });
    if (op.result) {
      const bad = typeMismatch(op.result, m.result.replace(/^Promise<(.+)>$/, "$1"));
      if (bad) err(`${where} result`, bad);
    }
  };
  const located = (e, key = "code") => {
    if (!e[key]) return null;
    const r = resolveRef(e[key]);
    if (!r.exists) err(e.name, `${r.file} does not exist`);
    else if (!r.decl) err(e.name, `${r.file} exports no ${r.symbol}`);
    checked++;
    return r.decl ?? null;
  };
  for (const it of model.items) {
    const d = located(it);
    if (!d) continue;
    if (it.values?.length) {
      if (!d.values) err(it.name, "is an enum in the model but not a union of string literals in the code");
      else if ([...d.values].sort().join("|") !== [...it.values].sort().join("|")) err(it.name, `values: model ${it.values.join("|")}, code ${d.values.join("|")}`);
      continue;
    }
    if (!d.props) {
      err(it.name, "has fields in the model but the code type has no members");
      continue;
    }
    const modelFields = new Set();
    for (const f of (it.fields ?? []).map(parseField)) {
      modelFields.add(f.name);
      const p = d.props.get(f.name);
      if (!p) {
        err(`${it.name}.${f.name}`, "missing in the code");
        continue;
      }
      const bad = typeMismatch(`${f.type.name}${f.type.many ? "[*]" : ""}`, p.type);
      if (bad) err(`${it.name}.${f.name}`, bad);
      if (f.type.optional !== (p.optional || normCode(p.type).optional)) err(`${it.name}.${f.name}`, f.type.optional ? "optional in the model, required in the code" : "required in the model, optional in the code");
    }
    for (const name of d.props.keys()) if (!modelFields.has(name)) warnings.push(`${it.name}.${name}: in the code but not in the model`);
  }
  for (const pt of model.portTypes) {
    const d = located(pt);
    if (!d) continue;
    for (const op of pt.provides ?? []) opMatches(`${pt.name}.${op.name}`, op, d.methods?.get(op.name), { signature: true });
  }
  for (const c of model.classifiers) {
    located(c, "data");
    const d = located(c);
    if (d?.kind !== "class") continue;
    for (const port of c.ports ?? []) {
      const T = port.type.replace(/^~/, "");
      if (port.type.startsWith("~")) {
        const holds = [...d.props.values()].some((p) => normCode(p.type).text === T);
        if (!holds) err(`${c.name}.${port.name}`, `calls ${T}, but the class holds no ${T} (property or constructor parameter)`);
      } else if (!d.implements.includes(T)) err(`${c.name}.${port.name}`, `provides ${T}, but the class does not implement ${T}`);
      checked++;
    }
    for (const op of c.operations ?? []) opMatches(`${c.name}.${op.name}`, op, d.methods.get(op.name), { signature: op.kind !== "internal" });
  }

  for (const w of warnings) console.log(`  · ${w}`);
  if (errors.length) {
    for (const e of errors) console.log(`  ✗ ${e}`);
    console.log(`✗ ${errors.length} error${errors.length === 1 ? "" : "s"}: the model and the code disagree`);
    process.exit(1);
  }
  console.log(`✓ consistent: ${checked} model elements checked against the code`);
}

// ---------------------------------------------------------------- render
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
/** Plain text with line breaks, as an HTML label. */
const lines = (s) => esc(s).replace(/\n/g, "<br>");
const TONES = {
  core: "fillColor=#f5f5f5;strokeColor=#333333;",
  files: "fillColor=#ffffff;strokeColor=#333333;dashed=1;",
  worker: "fillColor=#e1d5e7;strokeColor=#9673a6;",
  machine: "fillColor=#d5e8d4;strokeColor=#82b366;",
  external: "fillColor=none;strokeColor=#333333;",
};
const STROKE = { core: "#333333", files: "#333333", worker: "#9673a6", machine: "#82b366", external: "#333333" };
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

class Page {
  constructor(id, name) {
    Object.assign(this, { id, name, cells: [], n: 0 });
  }
  vertex(value, style, x, y, w, h, { parent = "1", link } = {}) {
    const id = `${this.id}-${++this.n}`;
    const geo = `<mxGeometry x="${Math.round(x)}" y="${Math.round(y)}" width="${w}" height="${h}" as="geometry"/>`;
    this.cells.push(link
      ? `<UserObject id="${id}" label="${esc(value)}" link="${esc(link)}"><mxCell style="${style}" vertex="1" parent="${parent}">${geo}</mxCell></UserObject>`
      : `<mxCell id="${id}" value="${esc(value)}" style="${style}" vertex="1" parent="${parent}">${geo}</mxCell>`);
    return id;
  }
  edge(source, target, label, style, points = [], labelAt = 0) {
    const id = `${this.id}-${++this.n}`;
    const way = points.length ? `<Array as="points">${points.map(([x, y]) => `<mxPoint x="${Math.round(x)}" y="${Math.round(y)}"/>`).join("")}</Array>` : "";
    this.cells.push(`<mxCell id="${id}" value="${esc(label ?? "")}" style="${style}" edge="1" source="${source}" target="${target}" parent="1"><mxGeometry ${labelAt ? `x="${labelAt}" ` : ""}relative="1" as="geometry">${way}</mxGeometry></mxCell>`);
    return id;
  }
  xml() {
    return `<diagram id="${this.id}" name="${esc(this.name)}"><mxGraphModel grid="0" page="0"><root><mxCell id="0"/><mxCell id="1" parent="0"/>${this.cells.join("")}</root></mxGraphModel></diagram>`;
  }
}
const pageLink = (id) => `data:page/id,${id}`;
const NOTE = "text;html=1;whiteSpace=wrap;align=left;verticalAlign=top;fontSize=11;fontColor=#666666;";
const EDGE = "edgeStyle=orthogonalEdgeStyle;rounded=1;html=1;fontSize=10;endArrow=open;endSize=10;labelBackgroundColor=#ffffff;";

/** Row index for each node of a graph: the longest path from a node with no incoming edges. */
function layers(ids, edges) {
  const depth = new Map(ids.map((id) => [id, 0]));
  for (let i = 0; i < ids.length; i++) for (const [a, b] of edges) if (depth.get(b) < depth.get(a) + 1) depth.set(b, depth.get(a) + 1);
  return depth;
}

/** The Design Element ID in the first lines of a source file, e.g. "// Motion planner module (DES-AT): ...". */
function designElementOf(ref) {
  const file = ref?.split("#")[0];
  if (!file || !existsSync(join(root, file))) return null;
  const head = readFileSync(join(root, file), "utf8").split("\n").slice(0, 5).join("\n");
  return /\b(DES-[A-Z]{1,4})\b/.exec(head)?.[1] ?? null;
}

async function tracespaceLinks() {
  if (!flag("--tracespace")) return null;
  try {
    const { TraceSpace } = await import(join(root, "trace/lib/client.mjs"));
    const { loadOrg, itemUrl } = await import(join(root, "trace/lib/org.mjs"));
    const ts_ = new TraceSpace();
    const org = await loadOrg(ts_);
    const orgId = await ts_.orgId();
    return (displayId) => {
      const item = org.byDisplayId.get(displayId);
      return item ? { url: itemUrl(ts_, orgId, item), title: item.title } : null; // url is null with TRACESPACE_LINKS=ids
    };
  } catch (e) {
    console.log(`  · no Trace.Space links (${e.message})`);
    return null;
  }
}

async function render() {
  const out = resolve(option("--out") ?? dirname(modelPath));
  const link = await tracespaceLinks();
  const pages = [];
  const ibd = new Page("ibd", "Parts and interfaces (IBD)");
  const ifaces = new Page("interfaces", "Interfaces and items");
  const activityPage = new Map(model.activities.map((a) => [a.name, new Page(slug(a.name), a.name)]));

  // ---- IBD: parts in rows (callers above providers), ports on the box edges, draw.io routes connectors
  const parts = allParts();
  const container = parts.find((p) => p.children?.length) ?? null;
  const inner = container ? container.children : model.ibd.parts;
  const partById = new Map(parts.map((p) => [p.id, p]));
  const portDef = (end) => {
    const [pid, pname] = end.split(".");
    return { part: partById.get(pid), port: classifier(partById.get(pid)?.type)?.ports?.find((x) => x.name === pname) };
  };
  // A connector runs from the caller (~T) to the provider (T).
  const conns = model.ibd.connectors.map((c) => {
    const a = portDef(c.from);
    const b = portDef(c.to);
    return a.port?.type.startsWith("~") ? { caller: a, provider: b } : { caller: b, provider: a };
  });
  const depth = layers(inner.map((p) => p.id), conns.map((c) => [c.caller.part.id, c.provider.part.id]));
  const rows = [];
  for (const p of inner) (rows[depth.get(p.id)] ??= []).push(p);
  const W = 260;
  const H = 80;
  const GAP_X = 90;
  const ROW_H = 230;
  const PAD = 40;
  const widest = Math.max(...rows.map((r) => r.length));
  const innerW = widest * W + (widest - 1) * GAP_X;
  const pos = new Map();
  rows.forEach((row, r) => {
    const rowW = row.length * W + (row.length - 1) * GAP_X;
    row.forEach((p, i) => pos.set(p.id, { x: PAD + (innerW - rowW) / 2 + i * (W + GAP_X), y: 70 + r * ROW_H }));
  });
  ibd.vertex(
    "Parts are <b>name : Type</b>. Ports are <b>name : PortType</b>; ~ marks the side that calls. Each connector joins a port type to its conjugate and is labeled with the operations called across it (arrow toward the provider). Labels like DES-AT name the Trace.Space Design Element the part implements.",
    `${NOTE}`, 0, -50, innerW + 2 * PAD, 40,
  );
  const boxH = 60 + rows.length * ROW_H - (ROW_H - H);
  const parent = container
    ? ibd.vertex(`<b>${esc(container.name)} : ${esc(container.type)}</b>${container.note ? `<br>${esc(container.note)}` : ""}`, `rounded=0;html=1;whiteSpace=wrap;align=left;verticalAlign=top;spacingLeft=8;spacingTop=4;${TONES.external}`, 0, 0, innerW + 2 * PAD, boxH + 40)
    : "1";
  const portCell = new Map();
  for (const p of inner) {
    const c = classifier(p.type);
    const tone = p.tone ?? "core";
    const { x, y } = pos.get(p.id);
    const box = ibd.vertex(
      `<b>${esc(p.name)} : ${esc(p.type)}</b>${p.note ? `<br><font style="font-size:10px">${esc(p.note)}</font>` : ""}`,
      `rounded=0;html=1;whiteSpace=wrap;fontSize=12;${TONES[tone]}`, x, y, W, H, { parent },
    );
    const des = designElementOf(c?.code);
    if (des) {
      const hit = link?.(des);
      ibd.vertex(hit?.url ? `${des} ↗` : des, "text;html=1;align=right;fontSize=10;fontColor=#1a73e8;", W - 96, 2, 90, 16, { parent: box, link: hit?.url });
    } else if (c?.code) ibd.vertex("no Design Element", "text;html=1;align=right;fontSize=10;fontColor=#b85450;", W - 116, 2, 110, 16, { parent: box });
    if (c?.behavior && activityPage.has(c.behavior)) {
      ibd.vertex(`↗ ${c.behavior}`, "text;html=1;align=left;fontSize=10;fontColor=#1a73e8;", 6, 2, 140, 16, { parent: box, link: pageLink(activityPage.get(c.behavior).id) });
    }
    // Ports: provided on top, called (~) on the bottom, ordered by where the other end sits.
    const ports = c?.ports ?? [];
    for (const side of ["top", "bottom"]) {
      const mine = ports.filter((pt) => (side === "bottom") === pt.type.startsWith("~"));
      const otherX = (pt) => {
        const cn = conns.find((k) => (k.caller.part.id === p.id && k.caller.port === pt) || (k.provider.part.id === p.id && k.provider.port === pt));
        const other = cn && (cn.caller.part.id === p.id ? cn.provider.part : cn.caller.part);
        return other ? pos.get(other.id)?.x ?? 0 : 0;
      };
      mine.sort((a, b) => otherX(a) - otherX(b));
      mine.forEach((pt, i) => {
        const px = ((i + 1) * W) / (mine.length + 1) - 6;
        const top = side === "top";
        const label = lines(`${pt.name}\n: ${pt.type}`);
        const style = `rounded=0;html=1;fontSize=9;resizable=0;strokeColor=${STROKE[tone]};fillColor=${top ? "#ffffff" : STROKE[tone]};labelPosition=right;align=left;spacingLeft=2;${top ? "verticalLabelPosition=top;verticalAlign=bottom;" : "verticalLabelPosition=bottom;verticalAlign=top;"}`;
        portCell.set(`${p.id}.${pt.name}`, {
          id: ibd.vertex(label, style, px, top ? -6 : H - 6, 12, 12, { parent: box }),
          x: x + px + 6,
          y: top ? y - 6 : y + H + 6,
        });
      });
    }
  }
  // Connectors that jog sideways each get their own horizontal lane, so they and their labels don't overlap.
  const laneCount = new Map();
  for (const k of conns) {
    const T = k.provider.port.type;
    const ops = (portType(T)?.provides ?? []).map((op) => `${op.name}()`).join(" · ");
    const from = portCell.get(`${k.caller.part.id}.${k.caller.port.name}`);
    const to = portCell.get(`${k.provider.part.id}.${k.provider.port.name}`);
    if (!from || !to) continue;
    let points = [];
    if (Math.abs(from.x - to.x) > 1) {
      const lane = laneCount.get(from.y) ?? 0;
      laneCount.set(from.y, lane + 1);
      const ly = from.y + 48 + lane * 26;
      points = [[from.x, ly], [to.x, ly]];
    }
    ibd.edge(from.id, to.id, ops, `${EDGE}exitX=0.5;exitY=1;entryX=0.5;entryY=0;`, points);
  }
  ibd.vertex("↗ Interfaces and items", "text;html=1;fontSize=11;fontColor=#1a73e8;align=left;", 0, boxH + 60, 200, 20, { link: pageLink(ifaces.id) });
  pages.push(ibd);

  // ---- Interfaces: one box per port type, item and data classifier, in columns
  ifaces.vertex("Port types list the operations their provider offers. Items are the data that crosses ports.", NOTE, 0, -40, 900, 30);
  ifaces.vertex("↩ Parts and interfaces (IBD)", "text;html=1;fontSize=11;fontColor=#1a73e8;align=left;", 920, -40, 220, 20, { link: pageLink(ibd.id) });
  const boxes = [
    ...model.portTypes.map((p) => ({ tag: "interface", name: p.name, doc: p.doc, lines: (p.provides ?? []).map(fmtOp), style: TONES.core })),
    ...model.items.map((i) => ({ tag: i.values?.length ? "enum" : "item", name: i.name, doc: i.doc, lines: i.values?.length ? i.values : i.fields ?? [], style: TONES.files.replace("dashed=1;", "") })),
  ];
  const COLS = 4;
  const BW = 300;
  const colY = Array(COLS).fill(0);
  for (const b of boxes) {
    const col = colY.indexOf(Math.min(...colY));
    const h = 54 + b.lines.length * 15;
    ifaces.vertex(
      `<font color="#666666">«${b.tag}»</font> <b>${esc(b.name)}</b><br><font style="font-size:10px" color="#666666">${esc(b.doc ?? "")}</font><hr>${b.lines.map(esc).join("<br>")}`,
      `rounded=0;html=1;whiteSpace=wrap;align=left;verticalAlign=top;spacingLeft=8;spacingTop=4;fontSize=11;${b.style}`,
      col * (BW + 30), colY[col], BW, h,
    );
    colY[col] += h + 24;
  }
  pages.push(ifaces);

  // ---- Activities: nodes in rows by depth from the initial node
  for (const act of model.activities) {
    const pg = activityPage.get(act.name);
    pg.vertex("↩ Parts and interfaces (IBD)", "text;html=1;fontSize=11;fontColor=#1a73e8;align=left;", 0, -50, 220, 20, { link: pageLink(ibd.id) });
    pg.vertex(`A behavior of ${act.of}. ${act.doc ?? ""} Actions show the operation, the part that performs it and the port it is called through.`, NOTE, 240, -50, 640, 34);
    const d = layers(act.nodes.map((n) => n.id), act.flows.map((f) => [f.from, f.to]));
    const rowsA = [];
    for (const n of act.nodes) (rowsA[d.get(n.id)] ??= []).push(n);
    const size = (n) => (n.kind === "action" ? [200, 64] : n.kind === "decision" ? [44, 44] : [32, 32]);
    const cell = new Map();
    const AW = 260;
    const wide = Math.max(...rowsA.map((r) => r.length));
    rowsA.forEach((row, r) => {
      row.forEach((n, i) => {
        const [w, h] = size(n);
        const cx = ((wide - row.length) / 2 + i + 0.5) * AW;
        const y = 20 + r * 130;
        const style = {
          initial: "ellipse;html=1;fillColor=#000000;strokeColor=#000000;",
          final: "ellipse;html=1;shape=doubleEllipse;fillColor=#000000;strokeColor=#000000;",
          decision: "rhombus;html=1;fillColor=#ffffff;strokeColor=#333333;",
          action: `rounded=1;arcSize=30;html=1;whiteSpace=wrap;fontSize=12;${TONES[n.tone ?? "core"].replace("dashed=1;", "")}`,
        }[n.kind];
        const label = n.kind === "action"
          ? `<b>${esc(n.name)}</b><br>(${esc(n.owner)})${n.via ? `<br><font color="#666666" style="font-size:10px">via ${esc(n.via)}</font>` : ""}`
          : "";
        const top = y + (64 - h) / 2;
        cell.set(n.id, { id: pg.vertex(label, style, cx - w / 2, top, w, h), cx, top, bottom: top + h, right: cx + w / 2, row: r });
      });
    });
    for (const f of act.flows) {
      const a = cell.get(f.from);
      const b = cell.get(f.to);
      // A flow that skips rows goes around the nodes in between, on the right.
      const between = [...cell.values()].filter((c) => c.row > a.row && c.row < b.row);
      const side = between.length ? Math.max(...between.map((c) => c.right), a.cx, b.cx) + 50 : null;
      const points = side ? [[a.cx, a.bottom + 24], [side, a.bottom + 24], [side, b.top - 24], [b.cx, b.top - 24]] : [];
      // Branches out of a decision share their first segment, so their guards sit near the target instead.
      const branch = act.nodes.find((n) => n.id === f.from)?.kind === "decision" && !side;
      pg.edge(a.id, b.id, f.guard ?? "", `${EDGE}exitX=0.5;exitY=1;entryX=0.5;entryY=0;`, points, branch ? 0.8 : 0);
    }
    pages.push(pg);
  }

  mkdirSync(out, { recursive: true });
  const file = join(out, `${model.name}.drawio`);
  writeFileSync(file, `<mxfile host="code-model">${pages.map((p) => p.xml()).join("")}</mxfile>\n`);
  console.log(`wrote ${file.replace(`${root}/`, "")}: ${pages.map((p) => p.name).join(", ")}`);

  if (flag("--png")) {
    const drawio = process.env.DRAWIO || "drawio";
    mkdirSync(join(out, "diagrams"), { recursive: true });
    pages.forEach((p, i) => {
      const png = join(out, "diagrams", `${slug(p.name)}.png`);
      execFileSync(drawio, ["-x", "-f", "png", "-s", "2", "-b", "16", "-p", String(i + 1), "-o", png, file], { stdio: "ignore" });
      console.log(`  ${png.replace(`${root}/`, "")}`);
    });
  }
}

if (command === "check") check();
else await render();
