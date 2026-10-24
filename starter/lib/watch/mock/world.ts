import type { LatLng } from "../schema"

// The mock world around the snapshot. Everything here is invented for the demo:
// the dataset holds terminals at city level only, so these pins are fictional gate points
// in those cities, and the routes are hand-drawn motorway approximations, not routing output.

export const TERMINAL_PINS: Record<string, LatLng> = {
  "terminal-west-baltic": [53.5045, 9.9395],
  "terminal-east-nordic": [59.3505, 18.1045],
  "terminal-south-baltic": [55.7015, 12.6050],
  "terminal-south-finland": [60.2090, 25.1900],
}

// Fictional receiving points for the dealer sites used in the demo (the dataset has street addresses, no coordinates).
export const SITE_PINS: Record<string, LatLng> = {
  "site-020": [61.4850, 23.7300], // Kervandorio Tampere
  "site-051": [53.5650, 10.0300], // Kovellin Hamburg
}

export const ROUTES: Record<string, { label: string; points: LatLng[] }> = {
  // Kassel → Hannover → Soltau → Hamburg-Harburg → West Baltic terminal (A7).
  "a7-kassel-hamburg": {
    label: "A7 north to Hamburg",
    points: [
      [51.3290, 9.5150], [51.5330, 9.9100], [51.8000, 9.9600], [52.0600, 9.9200], [52.3000, 9.8500],
      [52.4600, 9.7600], [52.5850, 9.7450], [52.7000, 9.7000], [52.8450, 9.6250], [52.9400, 9.7600],
      [53.0100, 9.8800], [53.1500, 9.9300], [53.2500, 9.9900], [53.3800, 10.0100], [53.4400, 9.9750],
      [53.4700, 9.9500], [53.4950, 9.9350], [53.5045, 9.9395],
    ],
  },
  // Osnabrück → Bremen → Hamburg-Harburg → West Baltic terminal (A1).
  "a1-osnabrueck-hamburg": {
    label: "A1 north-east to Hamburg",
    points: [
      [52.3000, 8.0500], [52.5200, 8.2600], [52.7600, 8.4600], [52.9900, 8.7500], [53.0700, 8.9200],
      [53.1600, 9.1800], [53.2700, 9.4600], [53.3600, 9.7300], [53.4300, 9.9100], [53.4700, 9.9500],
      [53.4950, 9.9350], [53.5045, 9.9395],
    ],
  },
  // Turku → Loimaa side → Urjala → Tampere (route 9 direction), ending at the receiving dealer.
  "r9-turku-tampere": {
    label: "Route 9 north-east to Tampere",
    points: [
      [60.4518, 22.2666], [60.5200, 22.4300], [60.6150, 22.5800], [60.7400, 22.7600], [60.8500, 22.9500],
      [60.9500, 23.1900], [61.0700, 23.3800], [61.2000, 23.5300], [61.3200, 23.6500], [61.4400, 23.7400],
      [61.4850, 23.7300],
    ],
  },
  // Düsseldorf direction → A1 → Hamburg-Harburg → north across the Elbe to the receiving dealer.
  "a1-bremen-hamburg-city": {
    label: "A1 to Hamburg city",
    points: [
      [52.9900, 8.7500], [53.0700, 8.9200], [53.1600, 9.1800], [53.2700, 9.4600], [53.3600, 9.7300],
      [53.4300, 9.9100], [53.4800, 9.9900], [53.5300, 10.0200], [53.5650, 10.0300],
    ],
  },
  // Linköping → Norrköping → Nyköping → Södertälje → East Nordic terminal (E4).
  "e4-linkoping-stockholm": {
    label: "E4 north to Stockholm",
    points: [
      [58.4100, 15.6200], [58.4900, 15.9500], [58.5900, 16.1800], [58.6700, 16.5600], [58.7500, 17.0000],
      [58.9300, 17.3300], [59.1000, 17.5500], [59.1950, 17.6250], [59.2600, 17.8500], [59.3000, 17.9900],
      [59.3300, 18.0600], [59.3505, 18.1045],
    ],
  },
}

export type Sailing = {
  id: string
  provider: string
  fromTerminalId: string
  toTerminalId: string
  departureAt: string
  checkInCutoffAt: string
  arrivalAt: string
  vehicleSlotsLeft: number
  fareDeltaCents: number
  // When the carrier stops selling the last slots for this sailing.
  salesCloseAt: string
}

// Later crossings a carrier would quote for the morning of 21 October. Not bookings.
// Ids carry the local departure time. The last slots on the evening sailing stop selling before
// the original check-in even closes, which is why the agent must bring the decision early.
export const SAILINGS: Sailing[] = [
  { id: "sail-wb-sf-1021-2200", provider: "Vela Coast Lines", fromTerminalId: "terminal-west-baltic", toTerminalId: "terminal-south-finland",
    departureAt: "2026-10-21T20:00:00Z", checkInCutoffAt: "2026-10-21T18:00:00Z", arrivalAt: "2026-10-23T04:00:00Z",
    vehicleSlotsLeft: 2, fareDeltaCents: 8500, salesCloseAt: "2026-10-21T11:40:00Z" },
  { id: "sail-wb-sf-1022-1400", provider: "Vela Coast Lines", fromTerminalId: "terminal-west-baltic", toTerminalId: "terminal-south-finland",
    departureAt: "2026-10-22T14:00:00Z", checkInCutoffAt: "2026-10-22T12:00:00Z", arrivalAt: "2026-10-23T20:00:00Z",
    vehicleSlotsLeft: 11, fareDeltaCents: 0, salesCloseAt: "2026-10-22T08:00:00Z" },
  { id: "sail-en-sf-1021-2100", provider: "Northgate Ferries", fromTerminalId: "terminal-east-nordic", toTerminalId: "terminal-south-finland",
    departureAt: "2026-10-21T21:00:00Z", checkInCutoffAt: "2026-10-21T19:30:00Z", arrivalAt: "2026-10-22T07:00:00Z",
    vehicleSlotsLeft: 6, fareDeltaCents: 4000, salesCloseAt: "2026-10-21T17:00:00Z" },
]

// Mock drive times from an arrival terminal to the delivery city, used to judge the delivery promise.
export const ONWARD_DRIVE_MIN: Record<string, Record<string, number>> = {
  "terminal-south-finland": { Helsinki: 30, Espoo: 40, Vantaa: 25, Lahti: 100, Tampere: 150, Turku: 140, Jyväskylä: 240, Oulu: 540 },
}
export const DEFAULT_ONWARD_DRIVE_MIN = 120

export type Hotel ={ id: string; name: string; nearTerminalId: string; nightlyCents: number; walkMinToTerminal: number }

export const HOTELS: Hotel[] = [
  { id: "hotel-wb-1", name: "Harbourline Rooms", nearTerminalId: "terminal-west-baltic", nightlyCents: 9200, walkMinToTerminal: 12 },
  { id: "hotel-wb-2", name: "Kai Seven Guesthouse", nearTerminalId: "terminal-west-baltic", nightlyCents: 7400, walkMinToTerminal: 25 },
  { id: "hotel-en-1", name: "Quayside Stay", nearTerminalId: "terminal-east-nordic", nightlyCents: 10400, walkMinToTerminal: 8 },
]
