import type { AddressInfo } from 'node:net'
import { describe, expect, it } from 'vitest'
import xrpl from 'xrpl'
import { signStatement, newNonce, localSigner, type StatementBody } from '@eng/core'
import { ProvisioningCoordinator, makeEnrolment, makeEnrolmentWithSigner, verifyEnrolment, createProvisioningServer, type SessionSpec, type CreatedSession } from '@eng/provisioning'

const roles = [{ role: 'owner', weight: 2 }, { role: 'agent', weight: 1 }, { role: 'cosigner', weight: 1 }]
function spec(account: string, mandate: ReturnType<typeof signStatement> | null = null): SessionSpec {
  return { engagementId: 'eng_prov_test', template: 'owner-wallet/procurement@1', account, asset: 'RLUSD', quorum: 2, roles, attesters: { vendor: { accounts: [] } }, deleteTo: 'rDeleteToXXXXXXXXXXXXXXXXXXXXXX', funder: 'rFunderXXXXXXXXXXXXXXXXXXXXXXX', fundingAmount: '5000', mandate }
}

describe('provisioning protocol (eng.provision/1)', () => {
  it('enrols three signers by proof-of-possession and assembles the SignerList + engagement record', () => {
    const coord = new ProvisioningCoordinator()
    const engAcct = xrpl.Wallet.generate().address
    const session = coord.createSession(spec(engAcct))
    const owner = xrpl.Wallet.generate(), agent = xrpl.Wallet.generate(), cosigner = xrpl.Wallet.generate()
    coord.enrol(makeEnrolment(session, 'owner', owner))
    coord.enrol(makeEnrolment(session, 'agent', agent))
    expect(coord.isComplete(session.sessionId)).toBe(false)
    coord.enrol(makeEnrolment(session, 'cosigner', cosigner))
    expect(coord.isComplete(session.sessionId)).toBe(true)

    const plan = coord.plan(session.sessionId)
    expect(plan.quorum).toBe(2)
    const byAddr = Object.fromEntries(plan.signerEntries)
    expect(byAddr[owner.address]).toBe(2)
    expect(byAddr[agent.address]).toBe(1)
    expect(byAddr[cosigner.address]).toBe(1)
    // XRPL requires SignerEntries sorted by account.
    expect(plan.signerEntries.map((e) => e[0])).toEqual([...plan.signerEntries.map((e) => e[0])].sort())
    expect(plan.engagement.parties).toEqual({ owner: owner.address, agent: agent.address, cosigner: cosigner.address })
    expect(plan.engagement.account).toBe(engAcct)
  })

  it('rejects an address that does not match the public key', () => {
    const coord = new ProvisioningCoordinator()
    const session = coord.createSession(spec(xrpl.Wallet.generate().address))
    const e = makeEnrolment(session, 'agent', xrpl.Wallet.generate())
    expect(() => coord.enrol({ ...e, address: xrpl.Wallet.generate().address })).toThrow(/derive to address/)
  })

  it('makeEnrolmentWithSigner: a custodied Signer (no private key in hand) enrols by PoP', async () => {
    const coord = new ProvisioningCoordinator()
    const session = coord.createSession(spec(xrpl.Wallet.generate().address))
    const w = xrpl.Wallet.generate()
    const e = await makeEnrolmentWithSigner(session, 'agent', localSigner(w))
    expect(e).toEqual(makeEnrolment(session, 'agent', w))
    expect(verifyEnrolment(session.sessionId, session.challenge, e)).toEqual({ ok: true })
    expect(coord.enrol(e)).toBeTruthy()
  })

  it('rejects a tampered proof', () => {
    const coord = new ProvisioningCoordinator()
    const session = coord.createSession(spec(xrpl.Wallet.generate().address))
    const e = makeEnrolment(session, 'agent', xrpl.Wallet.generate())
    const bad = e.proof.slice(0, -2) + (e.proof.endsWith('00') ? '11' : '00')
    expect(() => coord.enrol({ ...e, proof: bad })).toThrow(/proof|rejected/)
  })

  it('rejects an unknown role and an incomplete plan', () => {
    const coord = new ProvisioningCoordinator()
    const session = coord.createSession(spec(xrpl.Wallet.generate().address))
    expect(() => coord.enrol(makeEnrolment(session, 'intruder', xrpl.Wallet.generate()))).toThrow(/not part of/)
    expect(() => coord.plan(session.sessionId)).toThrow(/incomplete/)
  })

  it('carries a signed mandate into the plan', () => {
    const coord = new ProvisioningCoordinator()
    const owner = xrpl.Wallet.generate()
    const t = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
    const body: StatementBody = { v: 'eng.att/1', type: 'party.mandate/1', engagementId: 'eng_prov_test', subject: { mandateId: 'mnd_x' }, claim: { purpose: 't', budget: '5000.00', dailyCap: '3000.00', vendors: [], expires: t }, observedAt: t, issuedAt: t, nonce: newNonce(), attester: { account: owner.address, kind: 'PRINCIPAL' } }
    const mandate = signStatement(body, owner)
    const session = coord.createSession(spec(xrpl.Wallet.generate().address, mandate))
    for (const role of ['owner', 'agent', 'cosigner']) coord.enrol(makeEnrolment(session, role, xrpl.Wallet.generate()))
    const plan = coord.plan(session.sessionId)
    expect(plan.mandate?.id).toBe(mandate.id)
    expect(plan.engagement.mandateId).toBe(mandate.id)
  })

  it('serves the protocol over HTTP', async () => {
    const coord = new ProvisioningCoordinator()
    const server = createProvisioningServer(coord).listen(0, '127.0.0.1')
    await new Promise((r) => server.once('listening', r))
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    try {
      const engAcct = xrpl.Wallet.generate().address
      const created = await (await fetch(`${base}/v1/provision/sessions`, { method: 'POST', body: JSON.stringify({ spec: spec(engAcct) }) })).json() as CreatedSession
      for (const role of ['owner', 'agent', 'cosigner']) {
        const r = await fetch(`${base}/v1/provision/sessions/${created.sessionId}/enroll`, { method: 'POST', body: JSON.stringify(makeEnrolment(created, role, xrpl.Wallet.generate())) })
        expect(r.status).toBe(200)
      }
      const status = await (await fetch(`${base}/v1/provision/sessions/${created.sessionId}`)).json() as { complete: boolean; plan: { quorum: number } | null }
      expect(status.complete).toBe(true)
      expect(status.plan?.quorum).toBe(2)
    } finally { server.close() }
  })
})
