// Sensor fusion module (DES-AU): fuses camera, lidar and radar detections into one object list.
import type { VehicleParams } from "../config/params.ts";
import type { MountGeometry } from "./lidar-mount.ts";
import {
  SENSORS,
  type Detection,
  type ObjectClass,
  type ObjectList,
  type SensorFrame,
  type SensorHealth,
  type SensorId,
  type TrackedObject,
} from "./types.ts";

/** What the planner consumes. */
export interface ObjectSource {
  fuse(frame: SensorFrame): ObjectList;
}

/** What the safety supervisor polls. */
export interface HealthMonitor {
  health(nowMs: number): SensorHealth[];
}

/** Detections closer than this (m) are the same object. */
const ASSOCIATION_RADIUS_M = 1.0;
/** Processing-time model of the target compute (ms). */
const BASE_LATENCY_MS = 38;
const PER_DETECTION_MS = 0.35;
/** A sensor that hasn't reported for this long is unhealthy (ms). */
const HEALTH_TIMEOUT_MS = 40;

export class SensorFusion implements ObjectSource, HealthMonitor {
  private readonly lastSeen = new Map<SensorId, number>();
  private readonly rangeM: number;
  private readonly mount: MountGeometry;

  constructor(params: VehicleParams, mount: MountGeometry) {
    this.rangeM = params.lidarRangeM;
    this.mount = mount;
  }

  fuse(frame: SensorFrame): ObjectList {
    const usable = frame.detections.filter((d) => this.inRange(d));
    for (const d of frame.detections) this.lastSeen.set(d.sensor, frame.captureMs);
    const clusters: Detection[][] = [];
    for (const d of usable) {
      const home = clusters.find((c) => Math.hypot(c[0].x - d.x, c[0].y - d.y) < ASSOCIATION_RADIUS_M);
      if (home) home.push(d);
      else clusters.push([d]);
    }
    const objects = clusters.map((c) => this.track(c));
    const latency = BASE_LATENCY_MS + PER_DETECTION_MS * frame.detections.length;
    return { captureMs: frame.captureMs, publishMs: frame.captureMs + latency, objects };
  }

  /** Mark a sensor as having reported (heartbeat without detections). */
  heartbeat(sensor: SensorId, atMs: number): void {
    this.lastSeen.set(sensor, atMs);
  }

  health(nowMs: number): SensorHealth[] {
    return SENSORS.map((sensor) => {
      const seen = this.lastSeen.get(sensor);
      return { sensor, ok: seen !== undefined && nowMs - seen <= HEALTH_TIMEOUT_MS, atMs: nowMs };
    });
  }

  private inRange(d: Detection): boolean {
    const r = Math.hypot(d.x, d.y);
    if (d.sensor === "lidar-primary") return r <= this.rangeM && r >= this.mount.blindZoneRadiusM();
    return r <= 2 * this.rangeM;
  }

  private track(c: Detection[]): TrackedObject {
    const x = c.reduce((s, d) => s + d.x, 0) / c.length;
    const y = c.reduce((s, d) => s + d.y, 0) / c.length;
    return {
      x,
      y,
      cls: classify(c),
      sensors: [...new Set(c.map((d) => d.sensor))],
      inCrosswalk: c.some((d) => d.inCrosswalk),
    };
  }
}

/** Camera label wins; otherwise lidar height and radar speed decide. */
export function classify(c: Detection[]): ObjectClass {
  const label = c.find((d) => d.label)?.label;
  if (label) return label;
  const h = c.find((d) => d.heightM !== undefined)?.heightM ?? 0;
  const v = c.find((d) => d.speedMps !== undefined)?.speedMps ?? 0;
  if (h > 1.3 && h < 2.1 && v < 3) return "pedestrian";
  if (h > 1.3 && h < 2.1 && v < 12) return "cyclist";
  if (h >= 1.2 && v >= 3) return "vehicle";
  if (h > 0.3 && h <= 1.3 && v > 0.5) return "animal";
  return "static";
}
