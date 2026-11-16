// CI context (GitHub Actions or a local run) and the ID conventions shared by the scripts.
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";

/** Trace.Space display IDs: <type short id>-<item short id>, e.g. REQ-T, TC-AR, DES-AT. */
export const ID_PATTERN = /\b(REQ|TC|DES|NEED)-[A-Z]{1,4}\b/g;

/** The Test Case ID a test name starts with, or null. */
export function testTag(name) {
  const m = /^(TC-[A-Z]{1,4})\b/.exec(name);
  return m ? m[1] : null;
}

export function idsIn(text) {
  return [...new Set(String(text ?? "").match(ID_PATTERN) ?? [])];
}

function git(cmd) {
  try {
    return execSync(`git ${cmd}`, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "";
  }
}

/**
 * The change under test, as text to scan for item IDs: commit messages (push or PR range) plus
 * the PR title and body. Each commit is { sha, message, url }.
 */
export function changeSet() {
  const ctx = ciContext();
  let event = {};
  if (process.env.GITHUB_EVENT_PATH) {
    try {
      event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"));
    } catch {
      event = {};
    }
  }
  const commitUrl = (sha) => (ctx.repoUrl ? `${ctx.repoUrl}/commit/${sha}` : null);
  let commits = [];
  if (event.pull_request) {
    const base = event.pull_request.base.sha;
    const head = event.pull_request.head.sha;
    commits = gitLog(`${base}..${head}`);
  } else if (Array.isArray(event.commits) && event.commits.length) {
    commits = event.commits.map((c) => ({ sha: c.id, message: c.message }));
  } else {
    commits = gitLog("-1");
  }
  commits = commits.map((c) => ({ ...c, url: commitUrl(c.sha) }));
  const pr = event.pull_request
    ? { number: event.pull_request.number, title: event.pull_request.title, body: event.pull_request.body ?? "", url: event.pull_request.html_url }
    : null;
  return { ctx, commits, pr };
}

function gitLog(range) {
  const out = git(`log --format=%H%x1f%B%x1e ${range}`);
  return out
    .split("\x1e")
    .map((r) => r.trim())
    .filter(Boolean)
    .map((r) => {
      const [sha, message] = r.split("\x1f");
      return { sha, message: message ?? "" };
    });
}

export function ciContext() {
  const e = process.env;
  const server = e.GITHUB_SERVER_URL ?? "https://github.com";
  const repo = e.GITHUB_REPOSITORY;
  return {
    sha: e.GITHUB_SHA ?? (git("rev-parse HEAD") || "0000000"),
    ref: e.GITHUB_HEAD_REF || e.GITHUB_REF_NAME || git("rev-parse --abbrev-ref HEAD") || "local",
    runNumber: e.GITHUB_RUN_NUMBER,
    repo,
    repoUrl: repo ? `${server}/${repo}` : null,
    buildUrl: repo && e.GITHUB_RUN_ID ? `${server}/${repo}/actions/runs/${e.GITHUB_RUN_ID}` : null,
    event: e.GITHUB_EVENT_NAME ?? "local",
  };
}
