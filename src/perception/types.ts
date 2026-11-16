// Data that crosses the perception boundary.

export type ObjectClass = "pedestrian" | "cyclist" | "vehicle" | "animal" | "static";

export type SensorId = "camera-front" | "lidar-primary" | "radar-front" | "radar-rear";

export const SENSORS: readonly SensorId[] = ["camera-front", "lidar-primary", "radar-front", "radar-rear"];

/** One raw detection from one sensor, in vehicle coordinates (m). */
export interface Detection {
  sensor: SensorId;
  x: number;
  y: number;
  /** Camera class guess, if the sensor classifies. */
  label?: ObjectClass;
  /** Bounding box height (m), from lidar. */
  heightM?: number;
  /** Speed over ground (m/s), from radar. */
  speedMps?: number;
  /** Inside a mapped crosswalk (set by map matching before fusion). */
  inCrosswalk?: boolean;
}

/** All detections captured at one instant. */
export interface SensorFrame {
  captureMs: number;
  detections: Detection[];
}

/** A fused, classified object. */
export interface TrackedObject {
  x: number;
  y: number;
  cls: ObjectClass;
  sensors: SensorId[];
  inCrosswalk?: boolean;
}

/** The fused output published to the planner. */
export interface ObjectList {
  captureMs: number;
  publishMs: number;
  objects: TrackedObject[];
}

export interface SensorHealth {
  sensor: SensorId;
  ok: boolean;
  atMs: number;
}
