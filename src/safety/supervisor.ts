// Safety supervisor: watches sensor health and puts the vehicle in a minimal risk condition
// (stopped in lane, hazards on) when a perception sensor is lost.
// No Design Element covers this module yet; the architecture cross-check reports it.
import type { HealthMonitor } from "../perception/fusion.ts";
import type { SensorId } from "../perception/types.ts";
import type { BrakeActuator, BrakeResponse } from "./brake-controller.ts";

export type SupervisorState = "nominal" | "mrc";

export interface FaultRecord {
  sensor: SensorId;
  detectedMs: number;
}

/** Deceleration used to reach the minimal risk condition (m/s²). */
const MRC_DECEL_MPS2 = 4;
/** Supervisor polling period (ms): 100 Hz. */
export const SUPERVISOR_PERIOD_MS = 10;

export class SafetySupervisor {
  private state: SupervisorState = "nominal";
  private readonly faults: FaultRecord[] = [];
  private lastBrake?: BrakeResponse;
  private readonly sensors: HealthMonitor;
  private readonly brakes: BrakeActuator;

  constructor(sensors: HealthMonitor, brakes: BrakeActuator) {
    this.sensors = sensors;
    this.brakes = brakes;
  }

  /** Poll sensor health; enter MRC on the first unhealthy sensor. */
  tick(nowMs: number): SupervisorState {
    for (const h of this.sensors.health(nowMs)) {
      if (!h.ok && !this.faults.some((f) => f.sensor === h.sensor)) {
        this.faults.push({ sensor: h.sensor, detectedMs: nowMs });
      }
    }
    if (this.faults.length > 0) {
      this.state = "mrc";
      this.lastBrake = this.brakes.apply({ decelMps2: MRC_DECEL_MPS2, reason: "mrc" });
    }
    return this.state;
  }

  current(): SupervisorState {
    return this.state;
  }

  faultLog(): readonly FaultRecord[] {
    return this.faults;
  }

  hazardsOn(): boolean {
    return this.lastBrake?.hazards ?? false;
  }
}
