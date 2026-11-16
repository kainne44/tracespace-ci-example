// Minimal Trace.Space API client (no dependencies). Configuration comes from the environment;
// locally, a .env file in the repo root is read too. Secrets are never printed.
//
//   TRACESPACE_CLIENT_ID, TRACESPACE_CLIENT_SECRET   an Integration client of your org
//   TRACESPACE_URL      the address you open Trace.Space at: copy it from your browser's address bar
//                       (any page works, e.g. an item link). The API host is derived from it.
//   TRACESPACE_API_BASE optional: the API URL, if it isn't the app's host with "api." in front
//   TRACESPACE_LINKS    "on" (default): reports and diagrams link to items. "ids": plain IDs only,
//                       so public output (PR comments, committed diagrams) names no host or org.
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const ROOT = fileURLToPath(new URL("../../", import.meta.url));

function loadDotEnv() {
  const path = `${ROOT}.env`;
  if (!existsSync(path)) return;
  for (const raw of readFileSync(path, "utf8").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || !line.includes("=")) continue;
    const i = line.indexOf("=");
    const k = line.slice(0, i).trim();
    const v = line.slice(i + 1).trim().replace(/^["']|["']$/g, "");
    if (!(k in process.env)) process.env[k] = v;
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const clean = (v) => (v || "").trim().replace(/\/+$/, "");
const withHost = (origin, fn) => {
  const u = new URL(origin);
  u.hostname = fn(u.hostname);
  return u.origin;
};

export class TraceSpace {
  constructor() {
    loadDotEnv();
    this.id = process.env.TRACESPACE_CLIENT_ID;
    this.secret = process.env.TRACESPACE_CLIENT_SECRET;
    if (!this.id || !this.secret) {
      throw new Error("TRACESPACE_CLIENT_ID and TRACESPACE_CLIENT_SECRET must be set");
    }
    const appUrl = clean(process.env.TRACESPACE_URL);
    const apiBase = clean(process.env.TRACESPACE_API_BASE);
    if (!/^https?:\/\/[^/]+/.test(appUrl || apiBase)) {
      throw new Error("Set TRACESPACE_URL to the address you open Trace.Space at (copy it from your browser's address bar)");
    }
    if (appUrl) {
      const u = new URL(appUrl);
      this.app = withHost(u.origin, (h) => h.replace(/^api\./, ""));
      this.urlOrgId = u.pathname.split("/").find((seg) => UUID.test(seg)) ?? null;
    }
    // The API lives on the app's host with "api." in front, unless TRACESPACE_API_BASE says otherwise.
    this.base = apiBase || withHost(this.app, (h) => `api.${h}`);
    this.app ??= withHost(this.base, (h) => h.replace(/^api\./, ""));
    this.linksOn = (process.env.TRACESPACE_LINKS || "on").trim().toLowerCase() !== "ids";
    this.token = null;
    this.expires = 0;
  }

  /** The web app's base URL, for links shown to people. */
  appBase() {
    return this.app;
  }

  async auth(force = false) {
    if (this.token && !force && Date.now() < this.expires - 30_000) return this.token;
    const body = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: this.id,
      client_secret: this.secret,
    });
    const r = await fetch(`${this.base}/auth/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body,
    });
    if (!r.ok) throw new Error(`auth failed: HTTP ${r.status}`);
    const p = await r.json();
    this.token = p.access_token;
    this.expires = Date.now() + Number(p.expires_in || 900) * 1000;
    return this.token;
  }

  /** The org's UUID (used in item URLs): the one in TRACESPACE_URL if the client can access it, else the token's first. */
  async orgId() {
    const tok = await this.auth();
    const claims = JSON.parse(Buffer.from(tok.split(".")[1], "base64url").toString());
    const raw = claims.orgIds ?? claims.orgId;
    const ids = Array.isArray(raw) ? raw : String(raw).split(",");
    return this.urlOrgId && ids.includes(this.urlOrgId) ? this.urlOrgId : ids[0];
  }

  async call(method, path, body) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const r = await fetch(`${this.base}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${await this.auth(attempt === 1)}`,
          "Content-Type": "application/json",
          Accept: "application/json",
          "User-Agent": "tracespace-ci-example/1.0",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      if (r.status === 401 && attempt === 0) continue;
      if (r.status === 429 || r.status >= 502) {
        await new Promise((res) => setTimeout(res, 1000 * (attempt + 1)));
        continue;
      }
      const text = await r.text();
      if (!r.ok) throw new Error(`HTTP ${r.status} ${method} ${path}\n${text.slice(0, 600)}`);
      return text ? JSON.parse(text) : null;
    }
    throw new Error(`gave up on ${method} ${path}`);
  }

  get(path) {
    return this.call("GET", path);
  }
  post(path, body) {
    return this.call("POST", path, body);
  }
  put(path, body) {
    return this.call("PUT", path, body);
  }
  delete(path) {
    return this.call("DELETE", path);
  }
}
