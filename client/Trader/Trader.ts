import { PoolValidationResults, TokenSafetyStatus } from '../PoolValidator/ValidationResult'
import { GeneralTokenCondition } from '../Swap'
import { Token, TokenAmount, WSOL } from '@raydium-io/raydium-sdk'
import { SOL_SPL_TOKEN_ADDRESS, PAYER, OWNER_ADDRESS } from "./Addresses"
import { DANGEROUS_EXIT_STRATEGY, ExitStrategy, RED_TEST_EXIT_STRATEGY, SAFE_EXIT_STRATEGY } from './ExitStrategy'
import { TradeRecord } from './TradesFetcher'
import { convertStringKeysToDataKeys } from '../Utils'
import { connection } from './Connection'
import { buyToken } from './BuyToken'
import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from '@solana/spl-token'
import { SellResults, sellToken } from './SellToken'
import { findDumpingRecord } from './TradesAnalyzer'

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
    return { kind: 'FAILED', reason: 'RED coin', txId: null }
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
    return { kind: 'FAILED', reason: 'No SOL in pair', txId: null }
  }

  const buyAmount = getBuyAmountInSOL(validationResults.safetyStatus)!
  const exitStrategy = getExitStrategy(validationResults.safetyStatus)!

  const buyResult = await buyToken(connection, PAYER, buyAmount, tokenBToken, tokenBAccountAddress, pool, SOL_SPL_TOKEN_ADDRESS)

  if (buyResult.kind !== 'SUCCESS') {
    //TODO: Handle errors
    return { kind: 'FAILED', reason: `Buy transaction failed`, txId: null }
  }

  const amountToSell = new TokenAmount(tokenBToken, buyResult.newTokenAmount, false)
  const sellResults = await sellToken(
    connection,
    buyAmount,
    amountToSell,
    pool,
    SOL_SPL_TOKEN_ADDRESS,
    tokenBAccountAddress,
    exitStrategy)

  return sellResults
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

