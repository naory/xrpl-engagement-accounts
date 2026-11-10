// Self-funded ("plain") pre-create/reclaim builders: the operating account funds each pooled
// account's reserve in XRP with ordinary transactions — no XLS-68. Used when the Sponsor amendment
// isn't available on the target network (e.g. XRPL Testnet today, which has RLUSD but not Sponsor).
//
// Same lifecycle as the sponsored path (xls68.ts); the reserve simply sits in the account and
// returns to the operating account on AccountDelete (Destination = operating). Pre-create config is
// signed by the account's master key in the order trust line → RegularKey → disable master (master
// disabled LAST), after which the account is controlled by the service RegularKey; reclaim is
// therefore signed by the service key, not the (now-disabled) master.
import { currencyHex, iou, ASF_DISABLE_MASTER, TF_SET_NO_RIPPLE } from './xrpl-io.ts'

type Json = Record<string, unknown>

/** Operating account funds a new account with XRP for base + object reserves and fee headroom. */
export function buildFundCreate(o: { operating: string; account: string; amountDrops: string }): Json {
  return { TransactionType: 'Payment', Account: o.operating, Destination: o.account, Amount: o.amountDrops }
}
/** Account opens the RLUSD trust line (master-signed, before the master is disabled). */
export function buildOpenTrustlinePlain(o: { account: string; currency: string; issuer: string; limit: string }): Json {
  return { TransactionType: 'TrustSet', Account: o.account, LimitAmount: iou(currencyHex(o.currency), o.issuer, o.limit) }
}
/** Account installs the service RegularKey (master-signed). */
export function buildSetServiceRegularKeyPlain(o: { account: string; serviceKey: string }): Json {
  return { TransactionType: 'SetRegularKey', Account: o.account, RegularKey: o.serviceKey }
}
/** Account disables its master key (master-signed, LAST). Afterwards the service RegularKey controls it. */
export function buildDisableMasterPlain(o: { account: string }): Json {
  return { TransactionType: 'AccountSet', Account: o.account, SetFlag: ASF_DISABLE_MASTER }
}
/** Reclaim step 1: close the (zero-balance) RLUSD trust line (service-signed). */
export function buildRemoveTrustlinePlain(o: { account: string; currency: string; issuer: string }): Json {
  return { TransactionType: 'TrustSet', Account: o.account, LimitAmount: iou(currencyHex(o.currency), o.issuer, '0'), Flags: TF_SET_NO_RIPPLE }
}
/** Reclaim step 2: delete the account; leftover XRP (incl. the reserves) returns to the operating account. */
export function buildReclaimDeletePlain(o: { account: string; deleteTo: string }): Json {
  return { TransactionType: 'AccountDelete', Account: o.account, Destination: o.deleteTo }
}
