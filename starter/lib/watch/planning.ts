// Turns a `terminal_road_estimates` record into the planned speed and spread the slack engine uses.
// The estimate is a historical planning range; the engine only borrows its average pace and width.

type RoadEstimate = { approximate_road_distance_km: number; drive_minutes_low: number; drive_minutes_high: number }

export const DEFAULT_PLANNING = { plannedSpeedKmh: 85, speedSpread: 0.15 }

export function planningFromEstimate(estimate: RoadEstimate | null | undefined): { plannedSpeedKmh: number; speedSpread: number } {
  if (!estimate || !estimate.approximate_road_distance_km || !estimate.drive_minutes_low || !estimate.drive_minutes_high) return DEFAULT_PLANNING
  const mid = (estimate.drive_minutes_low + estimate.drive_minutes_high) / 2
  return {
    plannedSpeedKmh: estimate.approximate_road_distance_km / (mid / 60),
    speedSpread: (estimate.drive_minutes_high - estimate.drive_minutes_low) / 2 / mid,
  }
}
