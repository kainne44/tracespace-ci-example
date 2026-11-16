// The autonomy stack: wires the modules together for one vehicle variant.
import { loadParams, type Variant, type VehicleParams } from "./config/params.ts";
import { SensorFusion } from "./perception/fusion.ts";
import { LidarMount } from "./perception/lidar-mount.ts";
import { MotionPlanner, type Point } from "./planning/motion-planner.ts";
import { BrakeController } from "./safety/brake-controller.ts";
import { CargoBrakeBooster } from "./safety/cargo-booster.ts";
import { SafetySupervisor } from "./safety/supervisor.ts";

/** Default mapped geofence: a 2 km × 1.5 km service area (m). */
export const SERVICE_AREA: Point[] = [
  { x: 0, y: 0 },
  { x: 2000, y: 0 },
  { x: 2000, y: 1500 },
  { x: 0, y: 1500 },
];

export interface AutonomyStack {
  params: VehicleParams;
  mount: LidarMount;
  fusion: SensorFusion;
  brakes: BrakeController;
  booster?: CargoBrakeBooster;
  planner: MotionPlanner;
  supervisor: SafetySupervisor;
}

export function buildStack(variant?: Variant, geofence: Point[] = SERVICE_AREA): AutonomyStack {
  const params = loadParams(variant);
  const mount = new LidarMount(params);
  const fusion = new SensorFusion(params, mount);
  const booster = params.variant === "van" ? new CargoBrakeBooster() : undefined;
  const brakes = new BrakeController(params, booster);
  const planner = new MotionPlanner(params, fusion, brakes, geofence);
  const supervisor = new SafetySupervisor(fusion, brakes);
  return { params, mount, fusion, brakes, booster, planner, supervisor };
}
