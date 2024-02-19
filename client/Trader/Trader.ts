import { PoolValidationResults, TokenSafetyStatus } from '../PoolValidator/ValidationResult'
import { GeneralTokenCondition } from '../Swap'
import { Token, TokenAmount, WSOL } from '@raydium-io/raydium-sdk'
import { SOL_SPL_TOKEN_ADDRESS, PAYER, OWNER_ADDRESS } from "./Addresses"
import { DANGEROUS_EXIT_STRATEGY, ExitStrategy, RED_TEST_EXIT_STRATEGY, SAFE_EXIT_STRATEGY } from './ExitStrategy'
import { TradeRecord, fetchLatestTrades } from './TradesFetcher'
import { convertStringKeysToDataKeys, formatDate, retryAsyncFunctionOrDefault } from '../Utils'
import { connection } from './Connection'
import { buyToken } from './BuyToken'
import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from '@solana/spl-token'
import { SellResults, sellToken } from './SellToken'
import { TrendAnalisis, analyzeTrend, findDumpingRecord } from './TradesAnalyzer'
import { PoolKeys } from '../PoolValidator/RaydiumPoolParser'

export type TraderResults = {
  boughtAmountInSOL: number | null,
  buyingTokenCondition: GeneralTokenCondition | null,
  soldForAmountInSOL: number | null,
  pnl: number | null,
  error: string | null
}

module.exports = async (data: PoolValidationResults) => {
  const sellResults = await tryPerformTrading(data)
  return sellResults
}

async function tryPerformTrading(validationResults: PoolValidationResults): Promise<SellResults> {
  if (validationResults.safetyStatus === 'RED') {
    console.log('RED token. Skipping')
    return { kind: 'FAILED', reason: 'RED coin', txId: null, boughtForSol: null, buyTime: null }
  }

  const pool = convertStringKeysToDataKeys(validationResults.pool)

  let tokenAMint = pool.baseMint.toString() === WSOL.mint ? pool.baseMint : pool.quoteMint;
  let tokenBMint = pool.baseMint.toString() !== WSOL.mint ? pool.baseMint : pool.quoteMint;
  let tokenBDecimals = pool.baseMint.toString() === tokenBMint.toString() ? pool.baseDecimals : pool.quoteDecimals;
  const tokenBToken = new Token(TOKEN_PROGRAM_ID, tokenBMint, tokenBDecimals)
  const tokenBAccountAddress = getAssociatedTokenAddressSync(tokenBMint, OWNER_ADDRESS, false);

  console.log(`Verify tokens A - ${tokenAMint.toString()}   B - ${tokenBMint.toString()}`);

  if (pool.quoteMint.toString() !== WSOL.mint && pool.baseMint.toString() !== WSOL.mint) {
    console.log(`No SOL in pair. Skip swapping.`);
    return { kind: 'FAILED', reason: 'No SOL in pair', txId: null, boughtForSol: null, buyTime: null }
  }

  const buyAmount = getBuyAmountInSOL(validationResults.safetyStatus)!
  const exitStrategy = getExitStrategy(validationResults.safetyStatus)!

  //Verify trend again before buyng
  const currentTrendResults = await getCurrentTrend(validationResults.pool)
  console.log(`Pool ${pool.id.toString()}. Trend before buying: ${JSON.stringify(currentTrendResults)}`)
  if (currentTrendResults.dumpTxs) {
    //Dumped
    return { kind: 'FAILED', reason: 'Trend before buy error: Dump detected', txId: null, boughtForSol: null, buyTime: null }
  }
  if (!currentTrendResults.analysis) {
    //Couldn't detect trend, dangerous
    return { kind: 'FAILED', reason: `Trend before buy error: Couldn't detect trend before buying. Dangerous`, txId: null, boughtForSol: null, buyTime: null }
  }

  if (currentTrendResults.analysis.type === 'DUMPING') {
    //Dumping trend, maybe it's already late
    return { kind: 'FAILED', reason: `Trend before buy error: Dumping trend detected right before buying, maybe it's already late. Dangerous`, txId: null, boughtForSol: null, buyTime: null }
  }

  console.log(`Pool ${pool.id.toString()}. Trend before buy is good: ${JSON.stringify(currentTrendResults.analysis)}`)

  const buyResult = await buyToken(connection, PAYER, buyAmount, tokenBToken, tokenBAccountAddress, pool, SOL_SPL_TOKEN_ADDRESS)
  const buyDate = new Date()

  if (buyResult.kind !== 'SUCCESS') {
    //TODO: Handle errors
    return { kind: 'FAILED', reason: `Buy transaction failed`, txId: null, buyTime: formatDate(buyDate), boughtForSol: null }
  }

  const amountToSell = new TokenAmount(tokenBToken, buyResult.newTokenAmount, false)
  let sellResults = await sellToken(
    connection,
    buyAmount,
    amountToSell,
    pool,
    SOL_SPL_TOKEN_ADDRESS,
    tokenBAccountAddress,
    exitStrategy)
  sellResults.buyTime = formatDate(buyDate)
  return sellResults
}

async function getCurrentTrend(poolKeys: PoolKeys): Promise<{ dumpTxs: [TradeRecord, TradeRecord] | null, analysis: TrendAnalisis | null }> {
  const latestTrades = await retryAsyncFunctionOrDefault(fetchLatestTrades, [connection, poolKeys, 200], [])
  const dumpRes = findDumpingRecord(latestTrades)
  if (dumpRes !== null) {
    return {
      dumpTxs: dumpRes,
      analysis: null
    }
  }

  let trendResults: TrendAnalisis | null = null
  if (latestTrades.length > 0) {
    trendResults = analyzeTrend(latestTrades, null, false, false)
  }
  return {
    dumpTxs: null,
    analysis: trendResults
  }
}

function getBuyAmountInSOL(tokenStatus: TokenSafetyStatus): number | null {
  switch (tokenStatus) {
    case 'RED': return null
    case 'YELLOW': return 0.2
    case 'GREEN': return 0.3
  }
}

function getExitStrategy(tokenStatus: TokenSafetyStatus): ExitStrategy | null {
  switch (tokenStatus) {
    case 'RED': return null
    case 'YELLOW': return DANGEROUS_EXIT_STRATEGY
    case 'GREEN': return SAFE_EXIT_STRATEGY
  }
}

