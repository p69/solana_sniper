import { parentPort } from 'worker_threads'
import { PoolValidationResults, PoolFeatures, TokenSafetyStatus } from './ValidationResult'
import { fetchPoolKeysForLPInitTransactionHash } from './RaydiumPoolParser'
import { Liquidity } from '@raydium-io/raydium-sdk'
import { connection } from './Connection'
import { checkToken } from './RaydiumSafetyCheck'
import { convertStringKeysToDataKeys } from '../Utils'

export type ValidatePoolData = {
  mintTxId: string,
  date: Date,
}

module.exports = async (data: ValidatePoolData) => {
  const validationResults = await validateNewPool(data.mintTxId)
  return validationResults
}

// parentPort?.on('message', async (data) => {
//   const msg = data as ValidatePoolData
//   const validationResults = await validateNewPool(msg.mintTxId)
//   parentPort?.postMessage(validationResults)
// })

async function validateNewPool(mintTxId: string): Promise<PoolValidationResults | string> {
  try {
    const { poolKeys, mintTransaction } = await fetchPoolKeysForLPInitTransactionHash(mintTxId); // With poolKeys you can do a swap
    const binaryPoolKeys = convertStringKeysToDataKeys(poolKeys)
    const info = await Liquidity.fetchInfo({ connection: connection, poolKeys: binaryPoolKeys });
    const features: PoolFeatures = Liquidity.getEnabledFeatures(info);

    if (!features.swap) {
      return {
        pool: poolKeys,
        poolInfo: info,
        poolFeatures: features,
        safetyStatus: 'RED',
        reason: 'Swapping is disabled'
      }
    }

    const safetyCheckResults = await checkToken(mintTransaction, binaryPoolKeys)

    if (safetyCheckResults === null) {
      return {
        pool: poolKeys,
        poolInfo: info,
        poolFeatures: features,
        safetyStatus: 'RED',
        reason: `Couldn't verify safety. 'checkToken' fucntion failed`
      }
    }

    const SAFE_LOCKED_LIQUIDITY_PERCENT = 0.9
    const MIN_PERCENT_NEW_TOKEN_INPOOL = 0.8
    const LOW_IN_USD = 1000;
    const HIGH_IN_USD = 100000000;

    /// Check is liquidiity amount is too low r otoo high (both are suspicous)
    if (safetyCheckResults.totalLiquidity.amountInUSD < LOW_IN_USD || safetyCheckResults.totalLiquidity.amountInUSD > HIGH_IN_USD) {
      return {
        pool: poolKeys,
        poolInfo: info,
        poolFeatures: features,
        safetyStatus: 'RED',
        reason: `Liquidity is too low or too high`
      }
    }

    if (safetyCheckResults.lockedPercentOfLiqiodity < SAFE_LOCKED_LIQUIDITY_PERCENT) {
      /// If locked percent of liquidity is less then SAFE_LOCKED_LIQUIDITY_PERCENT
      /// most likely it will be rugged at any time, better to stay away
      return {
        pool: poolKeys,
        poolInfo: info,
        poolFeatures: features,
        safetyStatus: 'RED',
        reason: `Big percent of liquidity is unlocked`
      }
    }

    /// When token is mintable but almost 100% LP is locked
    if (safetyCheckResults.lockedPercentOfLiqiodity >= 0.99) {
      /// Check percent in pool
      if (safetyCheckResults.newTokenPoolBalancePercent >= 0.99) {
        /// When almost all tokens in pool 
        if (safetyCheckResults.ownershipInfo.isMintable) {
          /// When token is still mintable
          /// We can try to get some money out of it          
          return {
            pool: poolKeys,
            poolInfo: info,
            poolFeatures: features,
            safetyStatus: 'YELLOW',
            reason: `Most of the tokens are in pool, but token is still mintable`
          }
        } else {
          /// When token is not mintable          
          return {
            pool: poolKeys,
            poolInfo: info,
            poolFeatures: features,
            safetyStatus: 'GREEN',
            reason: `Liquidity is locked. Token is not mintable. Green light`
          }
        }
      } else if (safetyCheckResults.newTokenPoolBalancePercent >= MIN_PERCENT_NEW_TOKEN_INPOOL) {
        /// When at least MIN_PERCENT_NEW_TOKEN_INPOOL tokens in pool 
        if (!safetyCheckResults.ownershipInfo.isMintable) {
          /// If token is not mintable          
          return {
            pool: poolKeys,
            poolInfo: info,
            poolFeatures: features,
            safetyStatus: 'YELLOW',
            reason: `At least 80% of the tokens are in pool, and token is not mintable`
          }
        } if (safetyCheckResults.newTokenPoolBalancePercent >= 0.95) {
          /// If token is mintable, but should not be dumped fast (from my experience)          
          return {
            pool: poolKeys,
            poolInfo: info,
            poolFeatures: features,
            safetyStatus: 'YELLOW',
            reason: `>95% of tokens are in pool, but token is still mintable`
          }
        } else {
          /// Many tokens are not in pool and token is mintable. Could be dumped very fast.          
          return {
            pool: poolKeys,
            poolInfo: info,
            poolFeatures: features,
            safetyStatus: 'RED',
            reason: `Many tokens are not in pool and token is mintable`
          }
        }
      } else {
        /// Too much new tokens is not in pool. Could be dumped very fast.        
        return {
          pool: poolKeys,
          poolInfo: info,
          poolFeatures: features,
          safetyStatus: 'RED',
          reason: `Less then ${MIN_PERCENT_NEW_TOKEN_INPOOL * 100}% of tokens are not in pool.`
        }
      }
    } else { /// When 10% or less is unlocked
      /// When token is not mintable
      if (!safetyCheckResults.ownershipInfo.isMintable) {
        /// We can try to get some money out of it        
        return {
          pool: poolKeys,
          poolInfo: info,
          poolFeatures: features,
          safetyStatus: 'YELLOW',
          reason: `10% or less liquidity is unlocked, but token is not mintable`
        }
      } else {
        /// 10% or less of LP is unlocked and token is mintable. Stay away.
        /// Better to stay away
        return {
          pool: poolKeys,
          poolInfo: info,
          poolFeatures: features,
          safetyStatus: 'RED',
          reason: `10% or less liquidity is unlocked and token is mintable`
        }
      }
    }
  } catch (e) {
    return `error: ${e}`
  }
}