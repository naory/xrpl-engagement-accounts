// Hotel stays out of the demo menus unless DEMO_ENABLE_HOTEL=1 or --enable-hotel.
import fs from 'node:fs'
import { describe, expect, it } from 'vitest'
import { SCENARIO_UNAVAILABLE, assertHotelDemoEnabled, hotelDemoEnabled, listedDemoScenarios, unavailableScenarioReply } from '../src/demo-scenarios.ts'

const repo = new URL('../../../', import.meta.url)

function read(rel: string): string {
  return fs.readFileSync(new URL(rel, repo), 'utf8')
}

function scenarioSelectValues(html: string): string[] {
  const select = html.match(/<select id="scenario">([\s\S]*?)<\/select>/)
  if (!select) throw new Error('scenario <select> missing from packages/web/public/index.html')
  return [...select[1].matchAll(/<option value="([^"]*)">/g)].map((match) => match[1])
}

describe('demo scenario list', () => {
  it('hides hotel by default', () => {
    expect(hotelDemoEnabled({}, [])).toBe(false)
    expect(hotelDemoEnabled({ DEMO_ENABLE_HOTEL: '' }, [])).toBe(false)
    expect(hotelDemoEnabled({ DEMO_ENABLE_HOTEL: '0' }, [])).toBe(false)
    expect(hotelDemoEnabled({ DEMO_ENABLE_HOTEL: 'true' }, ['node', 'demo'])).toBe(false)
    expect(listedDemoScenarios(false).map((scenario) => scenario.id)).toEqual(['procurement', 'bond', 'x402', 'mpp'])
  })

  it('shows hotel when DEMO_ENABLE_HOTEL=1 or --enable-hotel is set', () => {
    expect(hotelDemoEnabled({ DEMO_ENABLE_HOTEL: '1' }, [])).toBe(true)
    expect(hotelDemoEnabled({}, ['node', 'demo', '--enable-hotel'])).toBe(true)
    expect(listedDemoScenarios(true).map((scenario) => scenario.id)).toEqual(['procurement', 'hotel', 'bond', 'x402', 'mpp'])
  })

  it('the web demo lists every non-hotel scenario with no notice, and adds hotel only behind the flag', () => {
    const html = read('packages/web/public/index.html')
    const bar = html.match(/<div class="scenario-bar">[\s\S]*?<\/div>/)
    if (!bar) throw new Error('scenario bar missing')
    expect(scenarioSelectValues(html)).toEqual(listedDemoScenarios(false).map((scenario) => scenario.id))
    expect(bar[0]).not.toMatch(/hotel|frozen|legacy|ROADMAP|DEMO_ENABLE_HOTEL|enable-hotel/i)
    expect(html).not.toContain('id="hotelNote"')
    expect(html).not.toContain('frozen as legacy')
    expect(html).not.toContain('Hotel (hotel@2) is disabled')
    expect(html).toContain('id:"hotel"')
    const gate = html.slice(html.indexOf('function gateHotelScenario'))
    expect(gate.startsWith('function gateHotelScenario'), 'gateHotelScenario missing').toBe(true)
    expect(gate).toContain('CFG && CFG.enableHotel')
    expect(gate).toContain('opt.value = "hotel"')
    expect(gate.indexOf('if (on)')).toBeLessThan(gate.indexOf('opt.value = "hotel"'))
  })

  it('a disabled hotel request is exactly "scenario not available", on the 403 body and on the CLI', () => {
    expect(unavailableScenarioReply()).toEqual({ status: 403, contentType: 'text/plain; charset=utf-8', body: 'scenario not available' })
    expect(SCENARIO_UNAVAILABLE).toBe('scenario not available')
    const server = read('packages/web/src/server.ts')
    expect(server.match(/return refuseScenario\(res\)/g)).toHaveLength(2)
    expect(server).toContain('res.end(reply.body)')
    expect(server).not.toMatch(/frozen|legacy|ROADMAP|DEMO_ENABLE_HOTEL|enable-hotel/)

    const lines: string[] = []
    const error = console.error
    const exit = process.exit
    console.error = (...args: unknown[]) => { lines.push(args.map(String).join(' ')) }
    process.exit = ((code?: number) => { throw new Error(`exit ${code}`) }) as typeof process.exit
    try {
      expect(() => assertHotelDemoEnabled({}, ['node', 'demo'])).toThrow('exit 1')
      expect(lines).toEqual(['scenario not available'])
      lines.length = 0
      expect(() => assertHotelDemoEnabled({ DEMO_ENABLE_HOTEL: '1' }, [])).not.toThrow()
      expect(lines).toEqual([])
    } finally {
      console.error = error
      process.exit = exit
    }
  })

  it('the hotel Testnet scripts refuse to start before they touch the ledger', () => {
    const hotel = read('packages/cosigner/demo/hotel-testnet.ts')
    const dispute = read('packages/cosigner/demo/hotel-dispute-testnet.ts')
    expect(hotel.indexOf('assertHotelDemoEnabled()')).toBeGreaterThan(-1)
    expect(hotel.indexOf('assertHotelDemoEnabled()')).toBeLessThan(hotel.indexOf('URL_ = await resolveTestnetEndpoint()'))
    expect(dispute.indexOf('assertHotelDemoEnabled()')).toBeGreaterThan(-1)
    expect(dispute.indexOf('assertHotelDemoEnabled()')).toBeLessThan(dispute.indexOf('const { discovery, token, endpoint } = loadDiscovery()'))
    expect(hotel).toContain('assertDemoNetwork(client)')
    expect(dispute).toContain('assertDemoNetwork(client)')
    expect(read('packages/cosigner/demo/b1-testnet.ts')).toContain('assertDemoNetwork(client)')
  })
})
