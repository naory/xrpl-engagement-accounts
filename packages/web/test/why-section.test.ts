// The demo page carries the public "why" section. It must not depend on a network call,
// and it must not put process notes on the page.
import fs from 'node:fs'
import { describe, expect, it } from 'vitest'

const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8')

function whySection(): string {
  const start = html.indexOf('<section class="why" id="why"')
  const end = html.indexOf('<footer id="footer">')
  expect(start).toBeGreaterThan(-1)
  expect(end).toBeGreaterThan(start)
  return html.slice(start, end)
}

describe('why engagement accounts section', () => {
  it('replaces the header link with an in-page jump and a self-contained section', () => {
    expect(html).not.toContain('Why these accounts')
    expect(html).not.toContain('class="doclink"')
    expect(html).toContain('class="why-jump" href="#why">Why Engagement Accounts — alternatives &amp; use cases ↓')
    const hero = html.indexOf('id="hero"')
    const stage = html.indexOf('id="stage"')
    const why = html.indexOf('id="why"')
    expect(hero).toBeGreaterThan(-1)
    expect(hero).toBeLessThan(stage)
    expect(stage).toBeLessThan(why)

    const section = whySection()
    for (const label of ['Plain x402', 'Native XRPL Escrow', 'Custodial', 'EVM Escrow', 'Card Rails']) {
      expect(section).toContain(`>${label}</button>`)
    }
    expect(section).toContain('>Engagement Account</h3>')
    expect(section).toContain('1.4 XRP')
    expect(section).toContain('>0</div>')
    expect(section).toContain('120 drops')
    expect(section).toContain('~0.2 XRP')
    expect(section).toContain('marketplace-escrow@1')
    expect(section).toContain('SLA-backed agent jobs')
    expect(section).toContain('B2B trade and supplier invoices')
    expect(section).toContain('Metered cloud, GPU, and API commitments')
    expect(section).toContain('Bounties, audits, and milestones')
    expect(section).toContain('Domains, data, and license transfers')
    expect(section).toContain('When not to use one')
    expect(section).toContain('href="https://github.com/naory/xrpl-engagement-accounts/blob/main/docs/why-engagement-accounts.md" target="_blank" rel="noopener"')
    expect(section).not.toMatch(/fetch\s*\(/)
    expect(section).not.toMatch(/frozen|legacy|Option \(a\)|not built yet|pending activation|waiting-on/i)

    const script = html.slice(html.indexOf('function initWhy'))
    expect(script.startsWith('function initWhy'), 'initWhy missing').toBe(true)
    expect(script).toContain('data-why-tab')
    expect(script).not.toMatch(/fetch\s*\(/)
  })
})
