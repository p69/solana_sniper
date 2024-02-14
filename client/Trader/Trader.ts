import { parentPort } from 'worker_threads'
import { PoolValidationResults, TokenSafetyStatus } from '../PoolValidator/ValidationResult'
import { GeneralTokenCondition } from '../Swap'
import { TOKEN_PROGRAM_ID, Token, TokenAmount, WSOL } from '@raydium-io/raydium-sdk'
import { SOL_SPL_TOKEN_ADDRESS, PAYER, OWNER_ADDRESS } from "./Addresses"
import { DANGEROUS_EXIT_STRATEGY, ExitStrategy, SAFE_EXIT_STRATEGY } from './ExitStrategy'
import { TradeRecord, fetchLatestTrades } from './TradesFetcher'
import { retryAsyncFunction } from '../Utils'
import { connection } from './Connection'
import { buyToken } from './BuyToken'
import { getAssociatedTokenAddressSync } from '@solana/spl-token'
import { sellToken } from './SellToken'

export type TraderResults = {
  boughtAmountInSOL: number | null,
  buyingTokenCondition: GeneralTokenCondition | null,
  soldForAmountInSOL: number | null,
  pnl: number | null,
  error: string | null
}

type ChartTrend = 'GROWING' | 'DIPPING'

parentPort?.on('message', async (data) => {
  const validationResults = data as PoolValidationResults

  if (validationResults.safetyStatus === 'RED') {
    console.log('RED token. Skipping')
    //TODO: Handle errors
    return
  }

  const pool = validationResults.pool

  let tokenAMint = pool.baseMint.toString() === WSOL.mint ? pool.baseMint : pool.quoteMint;
  let tokenBMint = pool.baseMint.toString() !== WSOL.mint ? pool.baseMint : pool.quoteMint;
  let tokenBDecimals = pool.baseMint.toString() === tokenBMint.toString() ? pool.baseDecimals : pool.quoteDecimals;
  const tokenBToken = new Token(TOKEN_PROGRAM_ID, tokenBMint, tokenBDecimals)
  const tokenBAccountAddress = getAssociatedTokenAddressSync(tokenBMint, OWNER_ADDRESS, false);

  console.log(`Verify tokens A - ${tokenAMint.toString()}   B - ${tokenBMint.toString()}`);

  if (pool.quoteMint.toString() !== WSOL.mint && pool.baseMint.toString() !== WSOL.mint) {
    console.log(`No SOL in pair. Skip swapping.`);
    //TODO: Handle errors
    return;
  }

  let tradesHistory: TradeRecord[] = []
  try {
    tradesHistory = await retryAsyncFunction(fetchLatestTrades, [connection, pool.id, tokenBMint, tokenBDecimals])
  } catch (e) {
    console.log(`Failed to fetch trading history ${e}`)
    //TODO: Handle errors
    return
  }

  if (tradesHistory.length === 0) {
    //TODO: Handle errors
    return
  }

  const trend = determineTrend(tradesHistory)
  if (trend === 'DIPPING' && validationResults.safetyStatus === 'YELLOW') {
    //TODO: Handle errors
    console.log('Dipping trend for yellow coin. Skipping')
    return
  }

  const buyAmount = getBuyAmountInSOL(validationResults.safetyStatus)!
  const exitStrategy = getExitStrategy(validationResults.safetyStatus)!

  const buyResult = await buyToken(connection, PAYER, buyAmount, tokenBToken, tokenBAccountAddress, pool, SOL_SPL_TOKEN_ADDRESS)

  if (buyResult.kind !== 'SUCCESS') {
    //TODO: Handle errors
    return
  }

  const amountToSell = new TokenAmount(tokenBToken, buyResult.newTokenAmount, false)
  const sellResults = await sellToken(connection, buyAmount, amountToSell, pool, SOL_SPL_TOKEN_ADDRESS, tokenBAccountAddress, exitStrategy)

  parentPort?.postMessage(sellResults)
})

function getBuyAmountInSOL(tokenStatus: TokenSafetyStatus): number | null {
  switch (tokenStatus) {
    case 'RED': return null
    case 'YELLOW': return 0.3
    case 'GREEN': return 0.5
  }
}

function getExitStrategy(tokenStatus: TokenSafetyStatus): ExitStrategy | null {
  switch (tokenStatus) {
    case 'RED': return null
    case 'YELLOW': return DANGEROUS_EXIT_STRATEGY
    case 'GREEN': return SAFE_EXIT_STRATEGY
  }
}

function determineTrend(data: TradeRecord[]): ChartTrend {
  const recentData = data.slice(-14); // Last 14 data points, adjust as needed
  const total = recentData.reduce((acc, val) => acc + val.priceInSOL, 0);
  const average = total / recentData.length;

  const trend: ChartTrend = recentData[recentData.length - 1].priceInSOL > average ? 'GROWING' : 'DIPPING';
  return trend; // This is a very simplified way to determine the trend
}