// Lidar roof mount bracket (DES-AQ): the mounting geometry the perception stack is calibrated for.
import type { VehicleParams } from "../config/params.ts";

/** Geometry the fusion module needs from the sensor mount. */
export interface MountGeometry {
  heightM(): number;
  blindZoneRadiusM(): number;
}

/** Lowest beam of the primary lidar, below horizontal. */
const LOWEST_BEAM_DEG = 25;

export class LidarMount implements MountGeometry {
  private readonly height: number;

  constructor(params: VehicleParams) {
    this.height = params.sensorMountHeightM;
  }

  heightM(): number {
    return this.height;
  }

  /** Ground radius around the sensor that the lowest beam can't see. */
  blindZoneRadiusM(): number {
    return this.height / Math.tan((LOWEST_BEAM_DEG * Math.PI) / 180);
  }
}
