// XLS-68 Sponsored Fees and Reserves — pre-create and reclaim builders for the pre-created
// account pool (README §16.2). The operating ("sponsor") account carries every XRP cost: the
// base reserve (sponsored account creation), each owner-object reserve (the RLUSD trust line),
// and transaction fees. A pooled engagement account therefore never needs to hold XRP, and on
// AccountDelete the reserves are returned to the sponsor by ledger rule (Destination == Sponsor).
//
// Authorization uses the CO-SIGNATURE path: the account signs, then the operating account
// co-signs with xrpl.signAsSponsor (which adds the SponsorSignature field). No on-ledger
// `Sponsorship` budget object is created, so there is no deletion-blocker to clear at close.
//
// Sequencing note (spike finding F1): SetRegularKey + AccountSet(asfDisableMaster) cannot run as
// Batch inner transactions (tecNEED_MASTER_KEY), so pre-create configuration is submitted as
// standalone master-signed transactions, not as a Batch.
//
// Seed storage for the pooled accounts is handled by the pool's SeedStore (see pool module); this
// file only builds and co-signs transactions.
import xrpl, { signAsSponsor } from 'xrpl'
import { currencyHex, iou, ASF_DISABLE_MASTER, TF_SET_NO_RIPPLE } from './xrpl-io.ts'

type Json = Record<string, unknown>
type Wallet = InstanceType<typeof xrpl.Wallet>

/** Payment flag: create the destination account as a sponsored account (reserve check waived). */
export const TF_SPONSOR_CREATED_ACCOUNT = 0x00080000
/** SponsorFlags: the sponsor pays this transaction's fee. */
export const SPF_SPONSOR_FEE = 0x00000001
/** SponsorFlags: the sponsor carries this transaction's new owner-object reserve. */
export const SPF_SPONSOR_RESERVE = 0x00000002

/** 1. Sponsor creates the engagement account; AccountRoot.Sponsor is set to the sponsor. Sponsor-signed. */
export function buildSponsoredCreate(o: { sponsor: string; account: string; amountDrops: string }): Json {
  return { TransactionType: 'Payment', Account: o.sponsor, Destination: o.account, Amount: o.amountDrops, Flags: TF_SPONSOR_CREATED_ACCOUNT }
}

/** 2. Account installs the service RegularKey (fee sponsored). Standalone (F1). Account-signed, then sponsor co-signs. */
export function buildSetServiceRegularKey(o: { account: string; sponsor: string; serviceKey: string }): Json {
  return { TransactionType: 'SetRegularKey', Account: o.account, RegularKey: o.serviceKey, Sponsor: o.sponsor, SponsorFlags: SPF_SPONSOR_FEE }
}

/** 3. Account disables its master key (fee sponsored). Standalone (F1), after the RegularKey is set. */
export function buildDisableMaster(o: { account: string; sponsor: string }): Json {
  return { TransactionType: 'AccountSet', Account: o.account, SetFlag: ASF_DISABLE_MASTER, Sponsor: o.sponsor, SponsorFlags: SPF_SPONSOR_FEE }
}

/** 4. Account opens an RLUSD trust line; both the fee and the new RippleState reserve are sponsored. */
export function buildOpenTrustline(o: { account: string; sponsor: string; currency: string; issuer: string; limit: string }): Json {
  return { TransactionType: 'TrustSet', Account: o.account, LimitAmount: iou(currencyHex(o.currency), o.issuer, o.limit), Sponsor: o.sponsor, SponsorFlags: SPF_SPONSOR_FEE | SPF_SPONSOR_RESERVE }
}

/** Reclaim step 1: close the (zero-balance) RLUSD trust line, returning its reserve to the sponsor. */
export function buildRemoveTrustline(o: { account: string; sponsor: string; currency: string; issuer: string }): Json {
  return { TransactionType: 'TrustSet', Account: o.account, LimitAmount: iou(currencyHex(o.currency), o.issuer, '0'), Flags: TF_SET_NO_RIPPLE, Sponsor: o.sponsor, SponsorFlags: SPF_SPONSOR_FEE }
}

/** Reclaim step 2: delete the account. Destination MUST equal the sponsor (else tecNO_SPONSOR_PERMISSION); leftover XRP + reserves return there. */
export function buildReclaimDelete(o: { account: string; sponsor: string }): Json {
  return { TransactionType: 'AccountDelete', Account: o.account, Destination: o.sponsor, Sponsor: o.sponsor, SponsorFlags: SPF_SPONSOR_FEE }
}

/**
 * Co-sign a transaction the account has already signed (`accountSignedBlob` is the account's
 * signed tx_blob). The transaction must already carry `Sponsor` + `SponsorFlags`. The returned
 * blob carries both the account signature and the SponsorSignature and is ready to submit.
 */
export function sponsorCosign(sponsor: Wallet, accountSignedBlob: string): string {
  const out = signAsSponsor(sponsor, accountSignedBlob) as unknown as string | { tx_blob: string }
  return typeof out === 'string' ? out : out.tx_blob
}
