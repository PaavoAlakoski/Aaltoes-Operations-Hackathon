// The demo morning: 21 October from the snapshot time. Five ferry bookings in the snapshot are
// still ahead of their check-in cutoff, and two domestic cars are due at dealers today. Each car
// gets a fictional position on a mock route and a driving profile. Three carry the stories; the
// rest are the quiet volume around them.

export type SpeedZone = { fromKmToGo: number; toKmToGo: number; speedKmh: number; label: string }
export type OfflineWindow = { fromMin: number; toMin: number; label: string }

export type ScenarioCar = {
  // ferry: watch the check-in of a booked crossing. delivery: watch the handover at the receiving dealer.
  kind: "ferry" | "delivery"
  orderId: string
  reservationId?: string
  routeId: string
  startKmToGo: number
  cruiseKmh: number
  zones: SpeedZone[]
  offline: OfflineWindow[]
  story?: string
}

export const DEMO_SCENARIO = {
  id: "morning-1021",
  label: "Ferry morning, 21 October",
  startAt: "2026-10-21T09:00:00Z",
  defaultSpeed: 60,
  cars: [
    {
      kind: "delivery", orderId: "ord-00452", routeId: "r9-turku-tampere",
      startKmToGo: 120, cruiseKmh: 95,
      zones: [{ fromKmToGo: 85, toKmToGo: 45, speedKmh: 12, label: "Detour after a road closure" }],
      offline: [],
      story: "A road closure eats into the delivery promise; the dealer's opening hours decide what is still possible today.",
    },
    {
      kind: "ferry", orderId: "ord-00603", reservationId: "res-x1082202e8d139d61", routeId: "a7-kassel-hamburg",
      startKmToGo: 85, cruiseKmh: 100,
      zones: [{ fromKmToGo: 34, toKmToGo: 14, speedKmh: 8, label: "Queue before the Elbe crossing" }],
      offline: [],
      story: "Traffic queue before the terminal eats the margin to check-in.",
    },
    {
      kind: "ferry", orderId: "ord-00324", reservationId: "res-x0c658361818f4c47", routeId: "e4-linkoping-stockholm",
      startKmToGo: 150, cruiseKmh: 95, zones: [],
      offline: [{ fromMin: 35, toMin: 70, label: "Phone off charge, app quiet" }],
      story: "The driver app goes quiet for half an hour; the car is fine.",
    },
    { kind: "delivery", orderId: "ord-00338", routeId: "a1-bremen-hamburg-city", startKmToGo: 140, cruiseKmh: 100, zones: [], offline: [] },
    { kind: "ferry", orderId: "ord-00075", reservationId: "res-xb44d75df6f852ca3", routeId: "a7-kassel-hamburg", startKmToGo: 118, cruiseKmh: 105, zones: [], offline: [] },
    { kind: "ferry", orderId: "ord-00439", reservationId: "res-xdecd36806483af6e", routeId: "a7-kassel-hamburg", startKmToGo: 215, cruiseKmh: 110, zones: [], offline: [] },
    { kind: "ferry", orderId: "ord-00584", reservationId: "res-x6196641f25ccf47f", routeId: "a1-osnabrueck-hamburg", startKmToGo: 240, cruiseKmh: 100, zones: [], offline: [] },
  ] satisfies ScenarioCar[],
} as const
