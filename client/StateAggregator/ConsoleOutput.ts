import Table from 'cli-table'
import { StateRecord, createStateRecord } from './StateTypes'
import { PoolKeys } from '../PoolValidator/RaydiumPoolParser'
import { WSOL } from '@raydium-io/raydium-sdk'
import { PoolValidationResults } from '../PoolValidator/ValidationResult'

///Color(+Reason)	First mint TX   StartTime		TokenId		PoolId		Liquidity		Locked Liquidity 		Percent in Pool		Is Mintable	 Buy		Sell 		Profit

let allRecordsByFirstMintTx = new Map<string, StateRecord>()

function getOrMakeRecordByTxId(mintTxId: string): StateRecord {
  return allRecordsByFirstMintTx.get(mintTxId) ?? createStateRecord({ firstMintTx: mintTxId, status: { safety: null, reason: null, isEnabled: true } })
}

//**** Pool creation + validation ****//
export function onNewPoolCreated(txId: string) {
  if (allRecordsByFirstMintTx.has(txId)) { return }
  allRecordsByFirstMintTx.set(txId, createStateRecord({ firstMintTx: txId, status: { safety: null, reason: null, isEnabled: true } }))
}

export function onNewPoolKeysFetched(firstMintTx: string, poolKeys: PoolKeys) {
  const record = getOrMakeRecordByTxId(firstMintTx)
  const poolId = poolKeys.id
  const tokenId = poolKeys.baseMint !== WSOL.mint ? poolKeys.baseMint : poolKeys.quoteMint;
  const updated = {
    ...record,
    poolId, tokenId
  }
  allRecordsByFirstMintTx.set(firstMintTx, updated)
}

export function onPoolIsDisabledOrDelayed(firstMintTx: string, startTimeEpoch: number | null) {
  const record = getOrMakeRecordByTxId(firstMintTx)
  const startTime = startTimeEpoch ? new Date(startTimeEpoch) : null
  const updated = {
    ...record,
    status: { ...record.status, isEnabled: false },
    startTime: startTime?.toLocaleString() ?? null
  }
  allRecordsByFirstMintTx.set(firstMintTx, updated)
}

export function onPoolValidationCompleted(firstMintTx: string, results: PoolValidationResults) {
  const record = getOrMakeRecordByTxId(firstMintTx)
  const updated = {
    ...record,
    status: { ...record.status, safety: results.safetyStatus, reason: results.reason, isEnabled: results.poolFeatures.swap },
  }
  allRecordsByFirstMintTx.set(firstMintTx, updated)
}

export function onPoolValidationFailed(firstMintTx: string, error: string) {
  const record = getOrMakeRecordByTxId(firstMintTx)
  const updated = {
    ...record,
    status: { ...record.status, reason: error },
  }
  allRecordsByFirstMintTx.set(firstMintTx, updated)
}

//**** Buy + Sell ****//
export function onStartedToBuy(firstMintTx: string, error: string) {
  const record = getOrMakeRecordByTxId(firstMintTx)
  const updated = {
    ...record,
    status: { ...record.status, reason: error },
  }
  allRecordsByFirstMintTx.set(firstMintTx, updated)
}