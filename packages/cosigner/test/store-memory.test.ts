import { describe, expect, it } from 'vitest'
import { MemoryStateStore } from '../src/store/memory.ts'
import { runStoreContract } from './store-contract.ts'

runStoreContract('MemoryStateStore', async () => new MemoryStateStore())

describe('MemoryStateStore copies', () => {
  it('deep-copies on write: mutating the input after the transaction does not change the store', async () => {
    const store = new MemoryStateStore()
    const input = { engagementId: 'e1', statement: { id: 'a1', type: 't' } as never, receipt: { statement: { id: 'r' } as never } }
    await store.transaction(async (tx) => { await tx.putAttestation(input) })
    ;(input.statement as { id: string }).id = 'changed'
    expect((await store.loadAll()).attestations[0].statement.id).toBe('a1')
  })
})
