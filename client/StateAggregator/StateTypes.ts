import { TokenSafetyStatus } from "../PoolValidator/ValidationResult"

export type PoolStatus = {
  safety: TokenSafetyStatus | null,
  isEnabled: boolean,
  reason: string | null
}

export type BuyTxInfo = {
  amountInSOL: number,
  txId: string | null,
  error: string | null,
  newTokenAmount: number | null
}

export type SellTxInfo = {
  soldForAmountInSOL: number | null,
  txId: string | null,
  error: string | null
}

export type StateRecord = {
  firstMintTx: string,
  status: PoolStatus,
  startTime: string | null,
  tokenId: string | null,
  poolId: string | null,
  liquidity: string | null,
  lockedLiquidity: string | null,
  percentInPool: string | null,
  isMintable: boolean | null,
  buyTx: BuyTxInfo | null,
  sellTx: SellTxInfo | null,
  profit: string | null
}

export function createStateRecord(
  requiredFields: Pick<StateRecord, 'firstMintTx' | 'status'>,
  optionalFields?: Partial<Omit<StateRecord, 'firstMintTx' | 'status'>>
): StateRecord {
  const defaultStateRecord: Omit<StateRecord, 'firstMintTx' | 'status'> = {
    startTime: null,
    tokenId: null,
    poolId: null,
    liquidity: null,
    lockedLiquidity: null,
    percentInPool: null,
    isMintable: null,
    buyTx: null,
    sellTx: null,
    profit: null,
  };

  return { ...defaultStateRecord, ...requiredFields, ...optionalFields };
}