// Brake controller (DES-AS): dual-channel electro-hydraulic brake controller.
import { G, type VehicleParams } from "../config/params.ts";

export type BrakeReason = "stop" | "yield" | "geofence" | "mrc" | "slow";

export interface BrakeCommand {
  decelMps2: number;
  reason: BrakeReason;
}

export interface BrakeResponse {
  decelMps2: number;
  channelsOk: number;
  hazards: boolean;
}

/** What the planner and the safety supervisor command. */
export interface BrakeActuator {
  apply(cmd: BrakeCommand): BrakeResponse;
  maxDecelMps2(): number;
}

/** Extra brake force from an assist unit (the van's cargo booster). */
export interface BrakeAssist {
  assistForceN(massKg: number, channelsOk: number): number;
}

/** Clamping force each hydraulic channel can deliver (N). */
const CHANNEL_FORCE_N = 12_000;
/** Dry asphalt friction coefficient the controller is calibrated for. */
const MU_DRY = 0.85;
/** Command-to-pressure delay (s). */
export const BRAKE_DELAY_S = 0.1;

export class BrakeController implements BrakeActuator {
  private channels = 2;
  private hazards = false;
  private readonly massKg: number;
  private readonly assist?: BrakeAssist;

  constructor(params: VehicleParams, assist?: BrakeAssist) {
    this.massKg = params.maxGrossMassKg;
    this.assist = assist;
  }

  /** Lose one hydraulic channel (fault injection). */
  injectChannelFault(): void {
    this.channels = Math.max(0, this.channels - 1);
    this.hazards = true;
  }

  channelsOk(): number {
    return this.channels;
  }

  maxDecelMps2(massKg: number = this.massKg): number {
    const force = this.channels * CHANNEL_FORCE_N + (this.assist?.assistForceN(massKg, this.channels) ?? 0);
    return Math.min(MU_DRY * G, force / massKg);
  }

  apply(cmd: BrakeCommand): BrakeResponse {
    if (cmd.reason === "mrc") this.hazards = true;
    const decel = Math.min(cmd.decelMps2, this.maxDecelMps2());
    return { decelMps2: decel, channelsOk: this.channels, hazards: this.hazards };
  }

  /** Distance (m) to stop from speedMps at massKg with full braking. */
  stoppingDistanceM(speedMps: number, massKg: number = this.massKg): number {
    return speedMps * BRAKE_DELAY_S + (speedMps * speedMps) / (2 * this.maxDecelMps2(massKg));
  }
}
