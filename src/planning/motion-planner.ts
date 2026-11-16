// Motion planner module (DES-AT): turn speed limit, lateral acceleration limit, speed governor,
// pedestrian yielding, geofence and takeover alerts.
import { MPH_TO_MPS, type VehicleParams } from "../config/params.ts";
import type { ObjectSource } from "../perception/fusion.ts";
import type { SensorFrame } from "../perception/types.ts";
import type { BrakeActuator, BrakeResponse } from "../safety/brake-controller.ts";

/** Turns tighter than this (m) are limited by the max turn speed parameter. */
export const TIGHT_TURN_RADIUS_M = 30;
/** Lateral acceleration comfort limit (m/s²), REQ-W. */
export const LAT_ACC_LIMIT_MPS2 = 3;
/** Takeover alerts are raised this far ahead of the required takeover (s). REQ-AN needs ≥ 3 s. */
export const TAKEOVER_LEAD_S = 4;
/** Deceleration used for yielding and geofence stops (m/s²). */
const COMFORT_DECEL_MPS2 = 3;

export interface Point {
  x: number;
  y: number;
}

export interface VehicleState {
  position: Point;
  speedMps: number;
  /** Seconds until the vehicle leaves its operational design domain, if known. */
  timeToOddExitS?: number;
}

export interface PlanDecision {
  targetSpeedMps: number;
  brake?: BrakeResponse;
  takeoverAlert: boolean;
  reason: "cruise" | "yield" | "geofence" | "turn";
}

export class MotionPlanner {
  private readonly maxTurnMps: number;
  private readonly maxSpeedMps: number;
  private readonly perception: ObjectSource;
  private readonly brakes: BrakeActuator;
  private readonly geofence: Point[];

  constructor(params: VehicleParams, perception: ObjectSource, brakes: BrakeActuator, geofence: Point[]) {
    this.maxTurnMps = params.maxTurnSpeedMph * MPH_TO_MPS;
    this.maxSpeedMps = params.maxOperatingSpeedMph * MPH_TO_MPS;
    this.perception = perception;
    this.brakes = brakes;
    this.geofence = geofence;
  }

  /** Speed governor (REQ-U): never command more than the max operating speed. */
  governSpeed(requestedMps: number): number {
    return Math.max(0, Math.min(requestedMps, this.maxSpeedMps));
  }

  /** Speed for a turn of radiusM (REQ-T, REQ-W). */
  planTurn(radiusM: number, requestedMps: number): number {
    let v = this.governSpeed(requestedMps);
    v = Math.min(v, Math.sqrt(LAT_ACC_LIMIT_MPS2 * radiusM));
    if (radiusM < TIGHT_TURN_RADIUS_M) v = Math.min(v, this.maxTurnMps);
    return v;
  }

  /** One planning cycle: perceive, then decide speed, braking and alerts. */
  step(frame: SensorFrame, state: VehicleState, requestedMps: number): PlanDecision {
    const objects = this.perception.fuse(frame).objects;
    const takeoverAlert = state.timeToOddExitS !== undefined && state.timeToOddExitS <= TAKEOVER_LEAD_S;
    const crossing = objects.some((o) => o.cls === "pedestrian" && o.inCrosswalk && o.x > 0);
    if (crossing) {
      const brake = this.brakes.apply({ decelMps2: COMFORT_DECEL_MPS2, reason: "yield" });
      return { targetSpeedMps: 0, brake, takeoverAlert, reason: "yield" };
    }
    const toEdge = this.distanceToGeofenceM(state.position);
    const stopDist = (state.speedMps * state.speedMps) / (2 * COMFORT_DECEL_MPS2);
    if (toEdge <= stopDist + 5) {
      const brake = this.brakes.apply({ decelMps2: COMFORT_DECEL_MPS2, reason: "geofence" });
      return { targetSpeedMps: 0, brake, takeoverAlert: true, reason: "geofence" };
    }
    return { targetSpeedMps: this.governSpeed(requestedMps), takeoverAlert, reason: "cruise" };
  }

  insideGeofence(p: Point): boolean {
    let inside = false;
    const g = this.geofence;
    for (let i = 0, j = g.length - 1; i < g.length; j = i++) {
      if (g[i].y > p.y !== g[j].y > p.y && p.x < ((g[j].x - g[i].x) * (p.y - g[i].y)) / (g[j].y - g[i].y) + g[i].x) {
        inside = !inside;
      }
    }
    return inside;
  }

  /** Distance from p to the nearest geofence edge (0 when outside). */
  distanceToGeofenceM(p: Point): number {
    if (!this.insideGeofence(p)) return 0;
    let best = Infinity;
    const g = this.geofence;
    for (let i = 0, j = g.length - 1; i < g.length; j = i++) {
      best = Math.min(best, segmentDistance(p, g[j], g[i]));
    }
    return best;
  }
}

function segmentDistance(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}
