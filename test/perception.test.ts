import assert from "node:assert/strict";
import { test } from "node:test";
import { classify } from "../src/perception/fusion.ts";
import type { Detection, ObjectClass } from "../src/perception/types.ts";
import { buildStack } from "../src/stack.ts";
import { percentile, rng } from "./helpers.ts";

test("TC-BE Fusion latency, hardware in the loop", () => {
  const { fusion } = buildStack();
  const r = rng(999);
  const latencies: number[] = [];
  for (let i = 0; i < 10_000; i++) {
    const n = Math.floor(r() * 120); // busy urban scenes reach ~120 detections
    const detections: Detection[] = Array.from({ length: n }, () => ({
      sensor: r() < 0.5 ? "lidar-primary" : "radar-front",
      x: 5 + r() * 80,
      y: r() * 20 - 10,
    }));
    const out = fusion.fuse({ captureMs: i * 33, detections });
    latencies.push(out.publishMs - out.captureMs);
  }
  const p999 = percentile(latencies, 99.9);
  assert.ok(p999 < 100, `99.9th percentile latency ${p999.toFixed(1)} ms`);
});

test("TC-BD Object classification benchmark", () => {
  // Labeled benchmark: lidar height and radar speed only (no camera label), the hard case.
  const r = rng(7);
  const truth: [ObjectClass, () => Detection[]][] = [
    ["pedestrian", () => [{ sensor: "lidar-primary", x: 10, y: 0, heightM: 1.5 + r() * 0.5 }, { sensor: "radar-front", x: 10, y: 0, speedMps: r() * 2 }]],
    ["cyclist", () => [{ sensor: "lidar-primary", x: 10, y: 0, heightM: 1.5 + r() * 0.5 }, { sensor: "radar-front", x: 10, y: 0, speedMps: 4 + r() * 6 }]],
  ];
  for (const [cls, make] of truth) {
    let hits = 0;
    const n = 1000;
    for (let i = 0; i < n; i++) if (classify(make()) === cls) hits++;
    assert.ok(hits / n >= 0.99, `${cls} recall ${((100 * hits) / n).toFixed(1)}%`);
  }
});

test("lidar mount blind zone grows with mount height", () => {
  const sedan = buildStack("sedan").mount;
  const van = buildStack("van").mount;
  assert.ok(van.blindZoneRadiusM() > sedan.blindZoneRadiusM());
});
