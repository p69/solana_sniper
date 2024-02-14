import { LiquidityPoolKeysV4, LiquidityPoolInfo } from "@raydium-io/raydium-sdk"

export type PoolFeatures = {
  swap: boolean,
  addLiquidity: boolean,
  removeLiquidity: boolean,
}

export type PoolValidationResults = {
  pool: LiquidityPoolKeysV4,
  poolInfo: LiquidityPoolInfo,
  poolFeatures: PoolFeatures,
  safetyStatus: TokenSafetyStatus,
  reason: string
}

export type TokenSafetyStatus =
  'RED' // 100% scam will be rugged very fast
  | 'YELLOW' // 99% scam, but we probably have bewteen 1-5 minutes to get some profit
  | 'GREEN' // 100% SAFE, if we are early should be easy to get 100%-10000%