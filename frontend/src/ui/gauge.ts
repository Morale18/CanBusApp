/** Arc dash length for circular gauges (270° sweep, r=42). */
export const GAUGE_ARC_MAX = 198;

export function gaugeDash(fraction: number): string {
  const f = Math.max(0, Math.min(1, fraction));
  return (f * GAUGE_ARC_MAX).toFixed(1);
}

export interface TracePaths {
  tracePath: string;
  areaPath: string;
  tipX: string;
  tipY: string;
}

const TRACE_W = 330;
const TRACE_H = 116;

/** Build SVG path for the speed trace chart (last ~20 s at 10 Hz). */
export function buildSpeedTrace(
  speeds: readonly number[],
  maxSpeed = 90,
): TracePaths {
  const empty: TracePaths = {
    tracePath: "",
    areaPath: "",
    tipX: String(TRACE_W),
    tipY: String(TRACE_H - 8),
  };
  if (speeds.length < 2) return empty;

  const step = TRACE_W / 83;
  const pts = speeds.map((v, i) => {
    const x = TRACE_W - (speeds.length - 1 - i) * step;
    const y =
      TRACE_H - 8 - Math.max(0, Math.min(1, v / maxSpeed)) * (TRACE_H - 20);
    return [x, y] as const;
  });

  const tracePath = pts
    .map((p, i) => `${i ? "L" : "M"}${p[0].toFixed(1)} ${p[1].toFixed(1)}`)
    .join(" ");

  const areaPath = `${tracePath} L${TRACE_W} ${TRACE_H} L${pts[0][0].toFixed(1)} ${TRACE_H} Z`;
  const last = pts[pts.length - 1];

  return {
    tracePath,
    areaPath,
    tipX: last[0].toFixed(1),
    tipY: last[1].toFixed(1),
  };
}

/** Exponential smoothing toward a target (matches design sim feel). */
export function smoothToward(
  current: number,
  target: number,
  dtSec: number,
  rate: number,
): number {
  return current + (target - current) * (1 - Math.exp(-dtSec * rate));
}

export const SMOOTH_RATES = {
  rpm: 2.32,
  speed: 1.3,
  throttle: 3.72,
  load: 2.32,
  coolant: 0.68,
  voltage: 2.13,
  fuel: 0.86,
  intake: 0.51,
} as const;
