import assert from "node:assert/strict";
import { test } from "node:test";
import { MPH_TO_MPS } from "../src/config/params.ts";
import { LAT_ACC_LIMIT_MPS2, TAKEOVER_LEAD_S } from "../src/planning/motion-planner.ts";
import { buildStack } from "../src/stack.ts";
import { rng } from "./helpers.ts";

const empty = (captureMs = 0) => ({ captureMs, detections: [] });

test("TC-AR Turn speed limit, planner simulation", () => {
  const { planner, params } = buildStack();
  const limit = params.maxTurnSpeedMph * MPH_TO_MPS;
  const r = rng(2000);
  for (let i = 0; i < 2000; i++) {
    const radius = 8 + r() * 22; // urban turns, 8 to 30 m
    const requested = (20 + r() * 50) * MPH_TO_MPS;
    const v = planner.planTurn(radius, requested);
    assert.ok(v <= limit + 1e-9, `turn ${i}: ${v.toFixed(2)} m/s > limit ${limit.toFixed(2)} m/s (r=${radius.toFixed(1)} m)`);
    assert.ok((v * v) / radius <= LAT_ACC_LIMIT_MPS2 + 1e-9, `turn ${i}: lateral acceleration over limit`);
    assert.ok(v <= requested + 1e-9, `turn ${i}: planner sped up the turn (${v.toFixed(2)} > ${requested.toFixed(2)} m/s)`);
  }
});

test("TC-BJ Operating speed governor", () => {
  const { planner, params } = buildStack();
  const limit = params.maxOperatingSpeedMph * MPH_TO_MPS;
  for (const overMph of [1, 5, 15, 40]) {
    const v = planner.governSpeed((params.maxOperatingSpeedMph + overMph) * MPH_TO_MPS);
    assert.ok(v <= limit + 1e-9, `commanded +${overMph} mph gave ${(v / MPH_TO_MPS).toFixed(1)} mph`);
  }
});

test("TC-BG Crosswalk yielding scenario suite", () => {
  const r = rng(40);
  for (let i = 0; i < 40; i++) {
    const { planner } = buildStack();
    const x = 5 + r() * 40;
    const y = r() * 4 - 2;
    const frame = {
      captureMs: i * 100,
      detections: [
        { sensor: "camera-front" as const, x, y, label: "pedestrian" as const, inCrosswalk: true },
        { sensor: "lidar-primary" as const, x: x + 0.2, y, heightM: 1.7, inCrosswalk: true },
      ],
    };
    const d = planner.step(frame, { position: { x: 1000, y: 750 }, speedMps: 11 }, 11);
    assert.equal(d.reason, "yield", `scenario ${i}: vehicle did not yield (pedestrian at ${x.toFixed(1)} m)`);
    assert.equal(d.targetSpeedMps, 0);
  }
});

test("TC-BH Takeover alert timing", () => {
  const { planner } = buildStack();
  // Walk toward an ODD exit in 0.1 s steps; the first alert must come ≥ 3 s ahead.
  let firstAlert: number | undefined;
  for (let t = 10; t >= 0; t -= 0.1) {
    const d = planner.step(empty(), { position: { x: 1000, y: 750 }, speedMps: 10, timeToOddExitS: t }, 10);
    if (d.takeoverAlert && firstAlert === undefined) firstAlert = t;
  }
  assert.ok(firstAlert !== undefined, "no takeover alert raised");
  assert.ok(firstAlert >= 3, `alert only ${firstAlert.toFixed(1)} s before takeover`);
  assert.ok(TAKEOVER_LEAD_S >= 3);
});

test("TC-BN Geofence boundary behavior", () => {
  const { planner } = buildStack();
  let pos = { x: 1000, y: 750 };
  let speed = 13;
  for (let i = 0; i < 2000 && speed > 0; i++) {
    const d = planner.step(empty(i * 100), { position: pos, speedMps: speed }, 13);
    if (d.reason === "geofence") speed = Math.max(0, speed - 3 * 0.1);
    pos = { x: pos.x + speed * 0.1, y: pos.y };
  }
  assert.equal(speed, 0, "vehicle never stopped");
  assert.ok(planner.insideGeofence(pos), `vehicle crossed the geofence (x=${pos.x.toFixed(1)} m)`);
});
