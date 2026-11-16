# Reproducing this in your own Trace.Space org

This repository is a worked example, not a drop-in kit. It shows one way to connect a codebase and
its CI to Trace.Space. This guide explains what each piece does, what it needs from your org, which
API calls it makes, and the pitfalls we hit, so you can build the same thing with your own scripts,
tools and conventions.

Everything here uses the public Trace.Space REST API with an Integration client. The scripts in
`trace/` add up to about 1,000 lines of plain Node with no dependencies. Read them alongside this
guide; each one is short and commented.

---

## 1. The idea

```text
           ┌──────────── Trace.Space ────────────┐
           │ Requirements ─Satisfaction→ Design  │
           │      │                      Elements│
           │ Verification                        │
           │      ↓                              │
           │ Test Cases (with steps)   Parameters│
           │ Variants pin item + parameter versions
           └───▲──────────▲──────────▲──────▲───┘
   parameters  │  results │   links  │      │ architecture
               │          │          │      │
  ┌────────────┴──────────┴──────────┴──────┴────────────┐
  │ CI: pull params → test per variant → gate → push runs │
  │     → comment on items → render + cross-check diagrams│
  └───────────────────────────────────────────────────────┘
```

Five independent capabilities. You can adopt any subset:

| # | Capability | Direction | Writes to the org? |
|---|---|---|---|
| A | Parameters from the org | org → code | no |
| B | Test results as Test Runs | code → org | Test Runs only |
| C | Traceability gate | org → CI verdict | no |
| D | Commit/PR links on items | code → org | comments only |
| E | Architecture diagrams, cross-checked | org + code → draw.io | no |

One design rule runs through all of them: **CI never edits items.** Test Runs, step results and
comments live beside the items and don't change item versions. So CI can run a hundred times a day
without making a single trace suspect or invalidating a baseline.

---

## 2. What you need in your org

| Need | Used by | In this example |
|---|---|---|
| An **Integration client** (client ID + secret) | all | one client, scoped to the org |
| Your **Trace.Space address**: the URL in your browser's address bar | all | configured as `TRACESPACE_URL` |
| A **Test Case** type, with test steps (Action / Expected result) | B, C | 19 Test Cases, each with steps |
| A **Requirement** type and a **verification** trace type, Requirement → Test Case | C, E | trace type "Verification" |
| A **Design Element** type and a **satisfaction** trace type, Requirement → Design Element | E | trace type "Satisfaction" |
| **Variants** (baselines with `isVariant`), if you have product variants | A, B, C | Sedan, SUV, Van |
| **Parameters** in the catalog, pinned by the variants | A | turn speed, mount height, mass, … |

Names are yours to choose. The scripts look types and trace types up by name, so map your names in
one place (see §8). If you have no variants, treat the whole org as a single "variant" (§8).

No Test Run configuration is needed: Test Run `fields` are free-form key/value pairs set per run.

Before wiring CI, get the org itself clean: every Test Case verifies a requirement, variants pin the
latest versions, no suspect traces. The gate (C) fails on suspect traces, so an untidy org means a
red build on day one.

---

## 3. One shared convention: display IDs

Every link between code and org rests on the **display ID** people already see in the app:
the type's short ID plus the item's short ID, e.g. `TC-AR`, `REQ-T`, `DES-AT`.

- **Tests** start their name with the Test Case they automate:
  `test("TC-AR Turn speed limit, planner simulation", …)`. Tests without a tag still run; they're
  just not reported to the org.
- **Commit messages, PR titles and PR bodies** mention items freely: `Fix brake latency (DES-AS)`.
- **Source files** name the Design Element they implement in their header comment:
  `// Motion planner module (DES-AT): …`.

Build the lookup once per run (`trace/lib/org.mjs`):

1. `GET /core/types` gives each type's `shortId` and its title field (`uiDisplayInfo.titleField`).
2. `POST /core/filter` with `{type:"Group", groupOp:"AND", filters:[{type:"IsDeleted", value:false}]}`
   lists live items. The response may be a bare array or `{items:[…]}`; handle both.
3. `POST /core/items/getMany` (chunks of ~500, body `[{id, version:null}]`) returns full items with
   `shortId`, `version` and `fields`.
4. Display ID = `${type.shortId}-${item.shortId}`.

Pick an ID pattern for your org (here `(REQ|TC|DES|NEED)-[A-Z]{1,4}`) and keep it in one place.

---

## 4. The capabilities

### A. Parameters from the org (`trace/pull-params.mjs`)

Code and tests read limits (max turn speed, mass, braking distance) from
`config/params.<variant>.json`, never from constants. CI re-pulls those files before testing, so the
code is always tested against the values the org holds for that variant.

API:
- `GET /core/baselines` → variants are the entries with `isVariant: true`.
- `GET /core/baselines/{id}` → `targets[]` with `kind` `"Item"` or `"Parameter"` and the pinned `version`.
- `GET /core/parameters/catalog` → the parameter list (wrapped in `.parameters`).
- `GET /core/parameters/catalog/{id}/versions` → every version's `payload` (`value`, `unit`).
  Take the version the variant pins, not the latest.

Map catalog names to code fields explicitly (`CATALOG_NAMES` in `src/config/params.ts`) so a renamed
parameter fails loudly. Commit the pulled files so tests also run offline, and have a `--check` mode
that fails when they're stale.

### B. Test results as Test Runs (`trace/reporter.mjs`, `trace/push-results.mjs`)

A custom test reporter writes `results/<variant>.json` (name, status, duration, failure message).
After the tests, one Test Run per variant is created and filled in:

1. `POST /core/testRuns` with a client-generated UUID `id`, a `name`, free-form `fields`
   (we use Variant, Commit, Branch, Build URL, Source), `isPubliclyVisible: true`, and
   `testCasesUnderRun: [{testCaseId, testCaseVersion}]`. Use **the version the variant pins**, so
   the run records exactly what was verified.
2. `PUT /core/testRuns/{id}/start`, which creates the executions.
3. `GET /core/testRuns/{id}/executions` → each execution already has its `steps`.
4. For each step: `PUT /core/testExecutions/{exId}/steps/{stepId}/result` with `{result}`.
   For a case with no steps: `PUT /core/testExecutions/{exId}/result` with `{manualResult}`.
5. Put the CI evidence (test name, duration, failure message) on the last step:
   `PUT /core/testExecutions/{exId}/steps/{stepId}/actualResult` with `{actualResult}`.
6. `PUT /core/testRuns/{id}/end`.

Only record runs from your main branch (or on demand), or PR builds will flood the org.
Skip tags that aren't Test Cases in that variant, and report them in the gate instead.

### C. Traceability gate (`trace/gate.mjs`, `trace/policy.json`)

A read-only check that turns org state plus test results into a pass/fail verdict and a Markdown
report (job summary + one PR comment, updated in place via a hidden marker).

| Check | Meaning |
|---|---|
| `unknown_test_tags` | a test is tagged with an ID that isn't a Test Case |
| `failing_tests` | a tagged test failed in this build |
| `suspect_traces` | a trace end points at an outdated item version |
| `unverified_requirements` | a requirement in a variant has no verifying Test Case |
| `failed_verification_in_org` | a Test Case's latest recorded result in the org is Failed |
| `param_drift` | committed parameter files differ from the org |
| `untraced_ids_in_change` | the change mentions an ID that isn't in the org |
| `architecture_drift` | the cross-check in E found a mismatch |

Each check is `fail | warn | off` in a policy file, and known gaps are listed with a reason
(`accepted_gaps`), so the policy is reviewed like code.

Useful API facts:
- Traces: `POST /core/items/traces/getMany` with a list of item IDs (chunks of ~200), then de-duplicate by trace `id`.
- Trace type **names** come from `GET /core/traceTypes`; `/core/types` doesn't include trace types.
  Ignore the structural types `PARENT`, `TEST_STEPS`, `TRACE_RULE`, `EXTERNAL`.
- A trace is **suspect** when any source/target `version` differs from that item's current version.
  You can compute this yourself; no endpoint needed.

### D. Commit and PR links (`trace/link.mjs`)

For each item ID found in the change (PR title, body and commits; or the pushed commits), post a
comment on the item that links back to the PR or commit.

- `POST /core/comments` with `id` (UUID), `itemId`, `commentText` (HTML), and **every other field
  present as `null`** (`markId`, `itemField`, `itemVersion`, `selectionText`, `reviewId`,
  `selectionIndex`, `author`), plus `userMentions: []`. Omitting them fails.
- Idempotency: `GET /core/comments/item/{itemId}` and skip if a comment already contains the URL.
  (`GET /core/comments/{id}` currently returns 500; use the per-item endpoint.)
- Comments don't bump item versions, so this is safe to run on every build.

### E. Architecture diagrams, cross-checked (`trace/diagrams.mjs`)

Two views of the architecture, built from different sources, compared automatically:

1. **From the code.** A model of the code's structure (parts, ports, flows) that a tool checks
   against the source and renders to draw.io. Here that's `model/autonomy-stack.model.json` and
   [`tools/code-model.mjs`](../tools/code-model.mjs) (one ~570-line script that uses only the `typescript`
   package the project already has). What makes it useful is that it's **checked against the code
   in CI**, so the diagram can't drift silently. The check parses the source files and compares:
   exported symbols, item fields and their types, enum values, interface operations and signatures,
   `implements` clauses for provided ports, and a held reference for each called port. Copy it and
   adapt the type mapping to your language, or use any other approach with the same property
   (diagrams generated from the code, SysML v2 kept beside the code with a checker, …).
   The model is also where draw.io meets Trace.Space: each part names its Design Element, so the
   rendered diagram links straight to the item.
2. **From the org.** Each Design Element with the requirements that satisfy it and their Test Cases,
   colored by the latest CI result, with every box linking to the item
   (`<your Trace.Space address>/<orgId>/items/<itemId>`). The org ID is in any item link you copy from
   the browser, and in the `orgIds` claim of the access token.
3. **Cross-check.** Match code parts to Design Elements (here, by the ID in each source file's
   header) and report: code with no Design Element, Design Elements with no code, IDs that don't
   exist, and variant membership. Feed the findings into the gate.

draw.io notes:
- A `.drawio` file is plain XML (`<mxfile><diagram><mxGraphModel><root>` with `mxCell`s). Wrap a
  cell in `<UserObject label=… link=…>` to make it clickable. Generating it directly takes ~100 lines;
  no library is required.
- PNG export uses the draw.io desktop app's CLI: `drawio -x -f png -p <page> -o out.png file.drawio`.
  Pages are numbered from 1 in current versions (0 before v27).
- In CI (Ubuntu), install the `.deb` from jgraph/drawio-desktop releases and run it under `xvfb-run`
  with `--no-sandbox --disable-gpu`. See the "Install draw.io" step in `.github/workflows/ci.yml`.
- Fonts differ between macOS and Linux, so the first CI render changes every PNG. After that, output
  is stable, and committing only when something changed avoids noise commits.

---

## 5. The pipeline

`.github/workflows/ci.yml`, in two jobs:

```text
test (matrix: one job per variant)          trace (after all test jobs)
  checkout, npm ci, typecheck                 download results + params
  pull this variant's parameters              render code diagrams (check model first)
  run tests → results/<variant>.json          render org diagram + cross-check
  upload results (even on failure)            gate → job summary, PR comment
                                              comment on mentioned items
                                              main only: push Test Runs,
                                                         commit refreshed diagrams/params [skip ci]
                                              fail the build if the gate failed
```

Choices worth copying:
- Tests run with `continue-on-error`, so failures still reach the gate and the org; the trace job
  fails the build at the end.
- `fetch-depth: 0` on the trace job, so the PR's commit range can be scanned for IDs.
- Credentials and the Trace.Space address as repository secrets (`TRACESPACE_CLIENT_ID`,
  `TRACESPACE_CLIENT_SECRET`, `TRACESPACE_URL`), so neither shows in logs.
- Item links in public output (PR comments, committed diagrams) switched off by default
  (`TRACESPACE_LINKS=ids`): they'd reveal your host and org ID. Turn them on in private repositories.
- Actions pinned to commit SHAs, since the job holds org credentials.
- The bot commit uses `[skip ci]`. If `main` is protected, allow the bot to push or open a PR instead.

---

## 6. API essentials

| Topic | Detail |
|---|---|
| Auth | `POST /auth/oauth/token`, `grant_type=client_credentials`, client ID + secret. Bearer token on every call. |
| Base URL | Don't hard-code a host. Ask people for the address they open Trace.Space at (from the browser's address bar) and derive the API from it: the same host with `api.` in front. Allow an override for setups where the API lives elsewhere. Links for people use the address as given. |
| Retries | Re-authenticate once on 401; back off on 429 and ≥502. |
| IDs | Clients generate UUIDs for new Test Runs and comments. |
| Response shapes | Some list endpoints return a bare array, others wrap it (`items`, `parameters`). Accept both. |
| Versions | Items carry `version`; traces and baselines reference `{id, version}`. Anything that edits an item bumps its version and can make traces suspect. |

The full OpenAPI description is served by the API; it's worth downloading once and searching it.

---

## 7. Suggested order

1. **Tidy the org**: Test Cases with steps, verification and satisfaction traces, variants pinned, no suspects.
2. **Display ID lookup + one dry-run script** that lists Test Cases. This proves auth and the lookup.
3. **Tag a few tests**, write the reporter, push one Test Run by hand, check it in the app.
4. **Gate** with most checks on `warn`, so it starts green; tighten later.
5. **Links**, then **parameters**.
6. **Diagrams**: the org view first (needs only the API), then the code view and the cross-check.
7. **CI**: wire the scripts into the workflow, add the secrets, and run it on a PR and on `main`.

Give every write script a dry-run mode, and keep a throwaway org (or test items) for experiments.

---

## 8. Adapting this repository's code

If you start from these scripts rather than writing your own, these are the VanLife-specific parts:

| What | Where |
|---|---|
| Variant names `sedan / suv / van` | workflow matrix, `run-tests.mjs`, `reporter.mjs`, the results filter in `push-results.mjs`, `gate.mjs`, `diagrams.mjs`, `src/config/params.ts` |
| Type names "Requirement", "Test Case", "Design Element" | `gate.mjs`, `push-results.mjs`, `diagrams.mjs` |
| Trace type names and accepted gaps | `trace/policy.json` |
| ID pattern | `trace/lib/ci.mjs` |
| Parameter name mapping | `CATALOG_NAMES` in `src/config/params.ts` |
| Code model | `model/autonomy-stack.model.json` (describes this demo's code only) |

No variants? Use one pseudo-variant, read every item at its current version, and skip parameter pinning.

`tools/code-model.mjs` is general: point it at your own model file. Its type mapping (String, Integer,
Real, Boolean, `[*]`, `?`) and source parsing are TypeScript-specific (§4 E).
