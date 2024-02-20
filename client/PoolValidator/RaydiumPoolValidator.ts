import { PoolValidationResults, PoolFeatures, TokenSafetyStatus } from './ValidationResult'
import { fetchPoolKeysForLPInitTransactionHash } from './RaydiumPoolParser'
import { Liquidity, LiquidityPoolInfo, LiquidityPoolKeysV4, LiquidityPoolStatus } from '@raydium-io/raydium-sdk'
import { checkToken } from './RaydiumSafetyCheck'
import { convertStringKeysToDataKeys, delay, retryAsyncFunction, retryAsyncFunctionOrDefault } from '../Utils'
import { Connection } from '@solana/web3.js'
import { fetchLatestTrades } from '../Trader/TradesFetcher'
import { TrendAnalisis, analyzeTrend, findDumpingRecord } from '../Trader/TradesAnalyzer'
import { config } from '../Config'

export type ValidatePoolData = {
  mintTxId: string,
  date: Date,
}

// module.exports = async (data: ValidatePoolData) => {
//   console.log(`Receive message in validation worker. TxId: ${data.mintTxId}.`)
//   const validationResults = await validateNewPool(data.mintTxId)
//   console.log(`Finished validation in validation worker. TxId: ${data.mintTxId}.`)
//   return validationResults
// }

export async function validateNewPool(connection: Connection, mintTxId: string): Promise<PoolValidationResults | string> {
  try {
    console.log(`Start validationg. TxId: ${mintTxId}.`)
    const { poolKeys, mintTransaction } = await fetchPoolKeysForLPInitTransactionHash(connection, mintTxId) // With poolKeys you can do a swap
    console.log(`Received pool info ${poolKeys.id} For mint TxId: ${mintTxId}.`)
    //TODO: notify state listener
    const binaryPoolKeys = convertStringKeysToDataKeys(poolKeys)
    const info = await tryParseLiquidityPoolInfo(connection, binaryPoolKeys)
    if (info === null) {
      return `Couldn't get LP info, perhaps RPC issues`
    }
    let startTime: number | null = null
    const status = info.status.toNumber()
    if (status === LiquidityPoolStatus.WaitingForStart) {
      //if (Date.now() / 1000 < startTime.toNumber())
      startTime = info.startTime.toNumber()
    }

    const features: PoolFeatures = Liquidity.getEnabledFeatures(info);

    if (!features.swap) {
      //TODO: notify state listener
      return {
        pool: poolKeys,
        poolInfo: info,
        poolFeatures: features,
        safetyStatus: 'RED',
        startTimeInEpoch: startTime,
        reason: 'Swapping is disabled',
        trend: null
      }
    }

    const safetyCheckResults = await checkToken(connection, mintTransaction, binaryPoolKeys)
    const latestTrades = await retryAsyncFunctionOrDefault(fetchLatestTrades, [connection, poolKeys], [])
    const dumpRes = findDumpingRecord(latestTrades)
    if (dumpRes !== null) {
      return {
        pool: poolKeys,
        poolInfo: info,
        poolFeatures: features,
        safetyStatus: 'RED',
        startTimeInEpoch: startTime,
        reason: `Already dumped. TX1: https://solscan.io/tx/${dumpRes[0].signature} TX2:TX1: https://solscan.io/tx/${dumpRes[1].signature}`,
        trend: null
      }
    }

    let trendResults: TrendAnalisis | null = null
    if (latestTrades.length > 0) {
      trendResults = analyzeTrend(latestTrades)
    }

    if (safetyCheckResults === null) {
      return {
        pool: poolKeys,
        poolInfo: info,
        poolFeatures: features,
        safetyStatus: 'RED',
        startTimeInEpoch: startTime,
        reason: `Couldn't verify safety. 'checkToken' fucntion failed`,
        trend: trendResults
      }
    }

    if (trendResults === null) {
      return {
        pool: poolKeys,
        poolInfo: info,
        poolFeatures: features,
        safetyStatus: 'RED',
        startTimeInEpoch: startTime,
        reason: `Couldn't check price trend for last transactions`,
        trend: trendResults
      }
    }

    if (trendResults.type === 'DUMPING') {
      return {
        pool: poolKeys,
        poolInfo: info,
        poolFeatures: features,
        safetyStatus: 'RED',
        startTimeInEpoch: startTime,
        reason: `Price trend is ${trendResults.type}`,
        trend: trendResults
      }
    }

    if (safetyCheckResults.newTokensWereMintedDuringValidation) {
      return {
        pool: poolKeys,
        poolInfo: info,
        poolFeatures: features,
        safetyStatus: 'RED',
        startTimeInEpoch: startTime,
        reason: `New tokens were minted during validation`,
        trend: trendResults
      }
    }

    const SAFE_LOCKED_LIQUIDITY_PERCENT = 0.9
    const MIN_PERCENT_NEW_TOKEN_INPOOL = 0.1
    const LOW_IN_USD = 500;
    const HIGH_IN_USD = 100000000;

    /// Check is liquidiity amount is too low r otoo high (both are suspicous)
    if (safetyCheckResults.totalLiquidity.amountInUSD < LOW_IN_USD || safetyCheckResults.totalLiquidity.amountInUSD > HIGH_IN_USD) {
      return {
        pool: poolKeys,
        poolInfo: info,
        poolFeatures: features,
        safetyStatus: 'RED',
        startTimeInEpoch: startTime,
        reason: `Liquidity is too low or too high. ${safetyCheckResults.totalLiquidity.amount} ${safetyCheckResults.totalLiquidity.symbol}`,
        trend: trendResults
      }
    }

    if (!safetyCheckResults.isliquidityLocked) {
      /// If locked percent of liquidity is less then SAFE_LOCKED_LIQUIDITY_PERCENT
      /// most likely it will be rugged at any time, better to stay away
      return {
        pool: poolKeys,
        poolInfo: info,
        poolFeatures: features,
        safetyStatus: 'RED',
        startTimeInEpoch: startTime,
        reason: `Liquidity is not locked`,
        trend: trendResults
      }
    }

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
          startTimeInEpoch: startTime,
          reason: `Most of the tokens are in pool, but token is still mintable`,
          trend: trendResults
        }
      } else {
        /// When token is not mintable          
        return {
          pool: poolKeys,
          poolInfo: info,
          poolFeatures: features,
          safetyStatus: 'GREEN',
          startTimeInEpoch: startTime,
          reason: `Liquidity is locked. Token is not mintable. Green light`,
          trend: trendResults
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
          startTimeInEpoch: startTime,
          reason: `At least 80% of the tokens are in pool, and token is not mintable`,
          trend: trendResults
        }
      } if (safetyCheckResults.newTokenPoolBalancePercent >= 0.95) {
        /// If token is mintable, but should not be dumped fast (from my experience)          
        return {
          pool: poolKeys,
          poolInfo: info,
          poolFeatures: features,
          safetyStatus: 'YELLOW',
          startTimeInEpoch: startTime,
          reason: `>95% of tokens are in pool, but token is still mintable`,
          trend: trendResults
        }
      } else {
        /// Many tokens are not in pool and token is mintable. Could be dumped very fast.          
        return {
          pool: poolKeys,
          poolInfo: info,
          poolFeatures: features,
          safetyStatus: 'RED',
          startTimeInEpoch: startTime,
          reason: `Many tokens are not in pool and token is mintable`,
          trend: trendResults
        }
      }
    } else {
      /// Too much new tokens is not in pool. Could be dumped very fast.        
      return {
        pool: poolKeys,
        poolInfo: info,
        poolFeatures: features,
        safetyStatus: 'RED',
        startTimeInEpoch: startTime,
        reason: `Less then ${MIN_PERCENT_NEW_TOKEN_INPOOL * 100}% of tokens are in pool.`,
        trend: trendResults
      }
    }



  } catch (e) {
    return `error: ${e}`
  }
}

async function tryParseLiquidityPoolInfo(connection: Connection, poolKeys: LiquidityPoolKeysV4, attempt: number = 1, maxAttempts: number = 5): Promise<LiquidityPoolInfo | null> {
  try {
    console.log(`Getting LP info attempt ${attempt}.`)
    const info = await Liquidity.fetchInfo({ connection: connection, poolKeys: poolKeys })
    if (info !== null) {
      console.log(`Successfully fetched LP info from attempt ${attempt}`)
      return info; // Return the transaction if it's not null
    } else if (attempt < maxAttempts) {
      console.log(`Fetching LP info attempt ${attempt} failed, retrying...`)
      await delay(200) // Wait for the specified delay
      return tryParseLiquidityPoolInfo(connection, poolKeys, attempt + 1, maxAttempts)
    } else {
      console.log('Max attempts of fetching LP info reached, returning null')
      return null; // Return null if max attempts are reached
    }
  } catch (error) {
    console.error(`Fetching LP info attempt ${attempt} failed with error: ${error}, retrying...`)
    if (attempt < maxAttempts) {
      await delay(200) // Wait for the specified delay // Wait for the specified delay before retrying
      return tryParseLiquidityPoolInfo(connection, poolKeys, attempt + 1, maxAttempts)
    } else {
      console.log('Max attempts of fetching LP info reached, returning null')
      return null; // Return null if max attempts are reached
    }
  }
}
