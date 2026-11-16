// Cargo-rated brake booster (DES-AV): dual-stage booster fitted to the van only.
import type { BrakeAssist } from "./brake-controller.ts";

/** Second-stage assist force (N), engaged above the light-load threshold. */
const STAGE_TWO_FORCE_N = 6_000;
const LIGHT_LOAD_KG = 2_500;

export class CargoBrakeBooster implements BrakeAssist {
  assistForceN(massKg: number, channelsOk: number): number {
    if (channelsOk === 0) return 0;
    return massKg > LIGHT_LOAD_KG ? STAGE_TWO_FORCE_N : 0;
  }
}
