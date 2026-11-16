import assert from "node:assert/strict";
import { test } from "node:test";
import { FT_TO_M, MPH_TO_MPS } from "../src/config/params.ts";
import { SENSORS } from "../src/perception/types.ts";
import { SUPERVISOR_PERIOD_MS } from "../src/safety/supervisor.ts";
import { buildStack } from "../src/stack.ts";

test("TC-BC Sensor loss response", () => {
  for (const lost of SENSORS) {
    const { fusion, supervisor } = buildStack();
    let t = 0;
    for (; t < 1000; t += SUPERVISOR_PERIOD_MS) {
      for (const s of SENSORS) fusion.heartbeat(s, t);
      assert.equal(supervisor.tick(t), "nominal");
    }
    const lostAt = t;
    for (; t < lostAt + 500; t += SUPERVISOR_PERIOD_MS) {
      for (const s of SENSORS) if (s !== lost) fusion.heartbeat(s, t);
      supervisor.tick(t);
    }
    const fault = supervisor.faultLog().find((f) => f.sensor === lost);
    assert.ok(fault, `${lost}: loss never reported`);
    assert.ok(fault.detectedMs - lostAt <= 50, `${lost}: reported after ${fault.detectedMs - lostAt} ms`);
    assert.equal(supervisor.current(), "mrc", `${lost}: no minimal risk condition`);
    assert.ok(supervisor.hazardsOn(), `${lost}: hazards off`);
  }
});

test("TC-AZ Brake controller fault injection", () => {
  const { brakes, params } = buildStack();
  const v = 40 * MPH_TO_MPS;
  brakes.injectChannelFault();
  const r = brakes.apply({ decelMps2: 9, reason: "mrc" });
  assert.equal(r.channelsOk, 1);
  assert.ok(r.decelMps2 > 2, `single-channel deceleration only ${r.decelMps2.toFixed(2)} m/s²`);
  assert.ok(r.hazards, "hazards not on after the fault");
  const d = brakes.stoppingDistanceM(v);
  assert.ok(Number.isFinite(d), "vehicle does not stop");
  // Degraded stop may exceed the nominal braking distance, but not by more than 50%.
  assert.ok(d <= 1.5 * params.brakingDistanceFt * FT_TO_M, `degraded stop ${(d / FT_TO_M).toFixed(0)} ft`);
});

test("brake model meets the variant braking distance at max gross mass", () => {
  const { brakes, params } = buildStack();
  const d = brakes.stoppingDistanceM(40 * MPH_TO_MPS, params.maxGrossMassKg);
  assert.ok(d <= params.brakingDistanceFt * FT_TO_M, `${(d / FT_TO_M).toFixed(0)} ft > ${params.brakingDistanceFt} ft`);
});
