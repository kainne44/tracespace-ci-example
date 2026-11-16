// Vehicle parameters, per variant, pulled from the Trace.Space parameter catalog.
// `npm run trace:params` refreshes config/params.<variant>.json from the org; CI does it on every
// run, so the code is always tested against the values the variant is pinned to.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export type Variant = "sedan" | "suv" | "van";

export const VARIANTS: readonly Variant[] = ["sedan", "suv", "van"];

/** The values the software depends on, named as the code uses them. */
export interface VehicleParams {
  variant: Variant;
  maxTurnSpeedMph: number;
  sensorMountHeightM: number;
  brakingDistanceFt: number;
  maxGrossMassKg: number;
  maxOperatingSpeedMph: number;
  minCameraFps: number;
  lidarRangeM: number;
}

/** Catalog parameter name in Trace.Space -> field in VehicleParams. */
export const CATALOG_NAMES: Record<string, keyof Omit<VehicleParams, "variant">> = {
  "Max turn speed": "maxTurnSpeedMph",
  "Sensor mount height": "sensorMountHeightM",
  "Braking distance": "brakingDistanceFt",
  "Max gross mass": "maxGrossMassKg",
  "Max operating speed": "maxOperatingSpeedMph",
  "Min camera frame rate": "minCameraFps",
  "Lidar detection range": "lidarRangeM",
};

interface ParamsFile {
  variant: Variant;
  parameters: Record<string, { value: number; unit: string; version: number }>;
}

export function currentVariant(): Variant {
  const v = (process.env.VARIANT ?? "sedan").toLowerCase();
  if (!(VARIANTS as readonly string[]).includes(v)) {
    throw new Error(`VARIANT must be one of ${VARIANTS.join(", ")}, got ${v}`);
  }
  return v as Variant;
}

export function loadParams(variant: Variant = currentVariant()): VehicleParams {
  const path = fileURLToPath(new URL(`../../config/params.${variant}.json`, import.meta.url));
  const file = JSON.parse(readFileSync(path, "utf8")) as ParamsFile;
  const out: Partial<VehicleParams> = { variant };
  for (const [name, key] of Object.entries(CATALOG_NAMES)) {
    const p = file.parameters[name];
    if (!p) throw new Error(`${path}: missing parameter ${JSON.stringify(name)}`);
    out[key] = p.value;
  }
  return out as VehicleParams;
}

export const MPH_TO_MPS = 0.44704;
export const FT_TO_M = 0.3048;
export const G = 9.81;
