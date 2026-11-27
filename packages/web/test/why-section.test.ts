// The Why page is its own fragment. The comparison switcher is already in the HTML.
// It must not call the network, and it must not carry process notes.
import fs from 'node:fs'
import { describe, expect, it } from 'vitest'

const repo = new URL('../../../', import.meta.url)

function read(rel: string): string {
  return fs.readFileSync(new URL(rel, repo), 'utf8')
}

const why = read('packages/web/public/why.html')
const demo = read('packages/web/public/index.html')
const landing = read('packages/web/public/landing.html')

function nav(html: string): string {
  const start = html.indexOf('<nav class="sitenav"')
  const end = html.indexOf('</nav>', start)
  expect(start, 'sitenav missing').toBeGreaterThan(-1)
  return html.slice(start, end)
}

describe('why page', () => {
  it('holds the comparison, economics, use cases, and the GitHub doc link', () => {
    expect(why.startsWith('<meta charset="utf-8">')).toBe(true)
    expect(why).toContain('<section class="why" id="why"')
    for (const label of ['Plain x402', 'Native XRPL Escrow', 'Custodial', 'EVM Escrow', 'Card Rails']) {
      expect(why).toContain(`>${label}</button>`)
    }
    expect(why).toContain('>Engagement Account</h3>')
    expect(why).toContain('1.4 XRP')
    expect(why).toContain('>0</div>')
    expect(why).toContain('120 drops')
    expect(why).toContain('~0.2 XRP')
    expect(why).toContain('Trust model')
    expect(why).toContain('marketplace-escrow@1')
    expect(why).toContain('SLA-backed agent jobs')
    expect(why).toContain('B2B trade and supplier invoices')
    expect(why).toContain('Metered cloud, GPU, and API commitments')
    expect(why).toContain('Bounties, audits, and milestones')
    expect(why).toContain('Domains, data, and license transfers')
    expect(why).toContain('When not to use one')
    expect(why).toContain('href="https://github.com/naory/xrpl-engagement-accounts/blob/main/docs/why-engagement-accounts.md" target="_blank" rel="noopener"')
    expect(why).not.toMatch(/fetch\s*\(/)
    expect(why).not.toMatch(/frozen|legacy|Option \(a\)|not built yet|pending activation|waiting-on/i)
    const script = why.slice(why.indexOf('function initWhy'))
    expect(script.startsWith('function initWhy')).toBe(true)
    expect(script).toContain('data-why-tab')
    expect(script).not.toMatch(/fetch\s*\(/)
    expect(nav(why)).toContain('aria-current="page">Why Engagement Accounts')
  })

  it('leaves the demo page as the control room, with Demo marked current', () => {
    expect(demo).not.toContain('id="why"')
    expect(demo).not.toContain('why-jump')
    expect(demo).not.toContain('function initWhy')
    expect(demo).not.toContain('Why these accounts')
    expect(nav(demo)).toContain('aria-current="page">Demo')
    expect(nav(demo)).toContain('id="navWhy" href="why.html"')
    expect(nav(demo)).toContain('id="navOverview" href="landing.html"')
    expect(demo).toContain('window.__WHY_URL__')
    expect(demo).toContain('window.__DEMO_URL__')
    expect(demo).toContain('window.__HOME_URL__')
  })

  it('puts a Why button beside the demo call to action and marks Overview current', () => {
    expect(landing).toContain('class="cta-row')
    expect(landing).toContain('id="demoBtn"')
    expect(landing).toContain('Demo &mdash; live on XRPL Testnet')
    expect(landing).toContain('id="whyBtn"')
    expect(landing).toContain('Why Engagement Accounts')
    expect(nav(landing)).toContain('aria-current="page">Overview')
    expect(landing).toContain('window.__HOME_URL__')
    expect(landing).toContain('window.__WHY_URL__')
    expect(landing).toContain('window.__DEMO_URL__')
  })

  it('serves /why and publishes why.html with the same URL hooks', () => {
    const server = read('packages/web/src/server.ts')
    expect(server).toContain("url.pathname === '/why'")
    expect(server).toContain('window.__HOME_URL__="/"')
    expect(server).toContain('window.__WHY_URL__="/why"')
    expect(server).toContain('window.__DEMO_URL__="/demo"')
    const whyRoute = server.indexOf("url.pathname === '/why'")
    const demoRoute = server.indexOf("url.pathname === '/demo'")
    expect(whyRoute).toBeGreaterThan(-1)
    expect(whyRoute).toBeLessThan(demoRoute)

    const pages = read('.github/workflows/pages.yml')
    expect(pages).toContain('"$src/why.html"')
    expect(pages).toContain('_site/why.html')
    expect(pages).toContain('window.__HOME_URL__="index.html"')
    expect(pages).toContain('window.__WHY_URL__="why.html"')
    expect(pages).toContain('window.__DEMO_URL__="demo.html"')
  })
})
