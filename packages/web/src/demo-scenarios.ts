// Which scenarios the demo offers. Hotel (hotel@2) stays in the catalog so it can be turned
// back on, and is omitted from the selectable list unless DEMO_ENABLE_HOTEL=1 or --enable-hotel.

export const HOTEL_DEMO_NOTE =
  'Hotel (hotel@2) is disabled in the demo while it is frozen as legacy; see ROADMAP.md. Set DEMO_ENABLE_HOTEL=1 to re-enable.'

export interface DemoScenario {
  id: string
  label: string
}

/** Dropdown order. Hotel sits where the page used to list it, between procurement and the bond. */
export const DEMO_SCENARIOS: readonly DemoScenario[] = [
  { id: 'procurement', label: 'Procurement agent — owner wallet' },
  { id: 'hotel', label: 'Hotel stay — Research (hotel@2)' },
  { id: 'bond', label: 'Bonded marketplace — collateral & slashing' },
  { id: 'x402', label: 'x402 metered purchase — pay-per-use' },
  { id: 'mpp', label: 'MPP push payment — Stripe/Tempo rail' },
]

export function hotelDemoEnabled(env: NodeJS.ProcessEnv = process.env, argv: readonly string[] = process.argv): boolean {
  return env.DEMO_ENABLE_HOTEL === '1' || argv.includes('--enable-hotel')
}

/** Scenarios a demo menu should offer. Hotel is included only when the opt-in flag is on. */
export function listedDemoScenarios(enableHotel: boolean): DemoScenario[] {
  return DEMO_SCENARIOS.filter((scenario) => enableHotel || scenario.id !== 'hotel')
}

/** Refuse a hotel demo entry point. Prints the re-enable note and exits. No-op when the flag is on. */
export function assertHotelDemoEnabled(env: NodeJS.ProcessEnv = process.env, argv: readonly string[] = process.argv): void {
  if (hotelDemoEnabled(env, argv)) return
  console.error(HOTEL_DEMO_NOTE)
  process.exit(1)
}
