// Link commits and pull requests to the Trace.Space items they mention (REQ-T, TC-AR, DES-AT, ...).
//
//   node trace/link.mjs [--dry-run]
//
// On a pull request: one comment per mentioned item, pointing at the PR (title, body and commits
// are scanned). On a push: one comment per mentioned item per commit. Idempotent: an item that
// already has a comment with the same link is skipped. Comments don't change item versions, so
// nothing goes suspect.
import { randomUUID } from "node:crypto";
import { TraceSpace } from "./lib/client.mjs";
import { changeSet, idsIn } from "./lib/ci.mjs";
import { loadOrg } from "./lib/org.mjs";

const DRY = process.argv.includes("--dry-run");
const { ctx, commits, pr } = changeSet();
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const repoName = ctx.repo ?? "local repository";

// Each link: { url, ids, html }
const links = [];
if (pr) {
  const ids = idsIn([pr.title, pr.body, ...commits.map((c) => c.message)].join("\n"));
  links.push({
    url: pr.url,
    ids,
    html:
      `<p>🔀 Referenced in pull request <a href="${pr.url}">#${pr.number} ${esc(pr.title)}</a> ` +
      `in ${esc(repoName)} (${commits.length} commit${commits.length === 1 ? "" : "s"}).</p>`,
  });
} else {
  for (const c of commits) {
    const ids = idsIn(c.message);
    if (!ids.length) continue;
    const first = c.message.split("\n")[0];
    const url = c.url ?? `commit:${c.sha}`;
    const anchor = c.url ? `<a href="${c.url}"><code>${c.sha.slice(0, 7)}</code></a>` : `<code>${c.sha.slice(0, 7)}</code>`;
    links.push({ url, ids, html: `<p>🔗 Referenced in commit ${anchor} on <code>${esc(ctx.ref)}</code> in ${esc(repoName)}: ${esc(first)}</p>` });
  }
}

if (!links.some((l) => l.ids.length)) {
  console.log("no item IDs mentioned; nothing to link");
  process.exit(0);
}

const ts = new TraceSpace();
const org = await loadOrg(ts);
const existing = new Map(); // itemId -> comment texts
let made = 0;
for (const l of links) {
  for (const id of l.ids) {
    const item = org.byDisplayId.get(id);
    if (!item) {
      console.log(`  ! ${id}: not an item in the org`);
      continue;
    }
    if (!existing.has(item.id)) {
      const comments = await ts.get(`/core/comments/item/${item.id}`);
      existing.set(item.id, (comments ?? []).map((c) => c.commentText ?? ""));
    }
    if (existing.get(item.id).some((t) => t.includes(l.url))) {
      console.log(`  = ${id}: already linked to ${l.url}`);
      continue;
    }
    console.log(`  ${DRY ? "·" : "+"} ${id} ${item.title}: ${l.url}`);
    if (DRY) continue;
    await ts.post("/core/comments", {
      id: randomUUID(),
      itemId: item.id,
      markId: null,
      itemField: null,
      itemVersion: null,
      commentText: l.html,
      selectionText: null,
      reviewId: null,
      selectionIndex: null,
      author: null,
      userMentions: [],
    });
    existing.get(item.id).push(l.html);
    made++;
  }
}
console.log(`${made} comment${made === 1 ? "" : "s"} added`);
