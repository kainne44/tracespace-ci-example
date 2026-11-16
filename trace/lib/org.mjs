// Load the parts of the org the pipeline needs, once: types, live items with display IDs
// (e.g. TC-AR), traces with trace-type names, variants and suspect state.

const FILTER_LIMIT = 10_000;

function chunks(list, n) {
  const out = [];
  for (let i = 0; i < list.length; i += n) out.push(list.slice(i, i + n));
  return out;
}

export async function loadOrg(ts) {
  const types = await ts.get("/core/types");
  const typeById = new Map(types.map((t) => [t.id, t]));
  const typeByName = new Map(types.map((t) => [t.name, t]));

  const res = await ts.post(`/core/filter?limit=${FILTER_LIMIT}`, {
    type: "Group",
    groupOp: "AND",
    filters: [{ type: "IsDeleted", value: false }],
  });
  const rows = Array.isArray(res) ? res : res.items ?? [];
  if (rows.length >= FILTER_LIMIT) throw new Error("org too large for one filter call");

  // Full bodies (fields, versions) in chunks of 500.
  const items = [];
  for (const part of chunks(rows.map((r) => r.id), 500)) {
    items.push(...(await ts.post("/core/items/getMany", part.map((id) => ({ id, version: null })))));
  }
  for (const it of items) {
    const t = typeById.get(it.typeId);
    it.typeName = t?.name;
    it.displayId = t ? `${t.shortId}-${it.shortId}` : it.shortId;
    it.title = it.fields?.[t?.uiDisplayInfo?.titleField ?? "Title"] ?? it.fields?.Title ?? "";
  }
  const byId = new Map(items.map((i) => [i.id, i]));
  const byDisplayId = new Map(items.map((i) => [i.displayId, i]));

  // Traces touching any item, in chunks of 200, de-duplicated.
  const traceMap = new Map();
  for (const part of chunks(items.map((i) => i.id), 200)) {
    for (const t of await ts.post("/core/items/traces/getMany", part)) traceMap.set(t.id, t);
  }
  const traceTypesRes = await ts.get("/core/traceTypes");
  const traceTypes = Array.isArray(traceTypesRes) ? traceTypesRes : traceTypesRes.items ?? [];
  const traceTypeById = new Map(traceTypes.map((t) => [t.id, t]));
  const traceTypeName = (t) => traceTypeById.get(t.type)?.name ?? (t.type === "PARENT" ? "Hierarchy" : t.type);
  const traces = [...traceMap.values()]
    .filter((t) => !["PARENT", "TEST_STEPS", "TRACE_RULE", "EXTERNAL"].includes(t.type))
    .map((t) => ({ ...t, typeName: traceTypeName(t) }));

  const isSuspect = (t) =>
    [...(t.sources ?? []), ...(t.targets ?? [])].some((e) => byId.has(e.id) && byId.get(e.id).version !== e.version);

  const variants = (await ts.get("/core/baselines")).filter((b) => b.isVariant);

  return {
    types,
    typeByName,
    traceTypes,
    items,
    byId,
    byDisplayId,
    traces,
    isSuspect,
    variants,
    ofType: (name) => items.filter((i) => i.typeName === name),
    tracesOf: (name) => traces.filter((t) => t.typeName === name),
  };
}

/** A variant's full baseline (targets with pinned versions), found by title (case-insensitive). */
export async function loadVariant(ts, org, name) {
  const v = org.variants.find((b) => b.title.toLowerCase() === name.toLowerCase());
  if (!v) throw new Error(`no variant named ${name}; have ${org.variants.map((b) => b.title).join(", ")}`);
  const full = await ts.get(`/core/baselines/${v.id}`);
  const itemPins = new Map(full.targets.filter((t) => t.kind === "Item").map((t) => [t.id, t.version]));
  const paramPins = new Map(full.targets.filter((t) => t.kind === "Parameter").map((t) => [t.id, t.version]));
  return { ...full, itemPins, paramPins };
}

/** Link to an item in the Trace.Space app, or null when links are off (TRACESPACE_LINKS=ids). */
export function itemUrl(ts, orgId, item) {
  if (!ts.linksOn) return null;
  return `${ts.appBase()}/${orgId}/items/${item.id}`;
}
