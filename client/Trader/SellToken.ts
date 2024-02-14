import { Connection, ParsedTransactionWithMeta, PublicKey } from "@solana/web3.js";
import { ExitStrategy } from "./ExitStrategy";
import { LiquidityPoolKeysV4, TokenAmount, WSOL } from "@raydium-io/raydium-sdk";
import { PAYER, WSOL_TOKEN } from "./Addresses";
import { swapTokens, waitForProfitOrTimeout } from "../Swap";
import chalk from "chalk";
import { getTransactionConfirmation, retryAsyncFunction } from "../Utils";

interface SellSuccess {
  kind: 'SUCCESS',
  txId: string,
  soldForSOL: number,
  estimatedProfit: number,
  profit: number
}

interface SellFailure {
  kind: 'FAILED',
  txId: string | null,
  reason: string
}
export type SellResults = SellSuccess | SellFailure

export async function sellToken(
  connection: Connection,
  spentAmount: number,
  amountToSell: TokenAmount,
  pool: LiquidityPoolKeysV4,
  mainTokenAccountAddress: PublicKey,
  shitcoinAccountAddress: PublicKey,
  exitStrategy: ExitStrategy): Promise<SellResults> {

  console.log(`Selling ${amountToSell} shitcoins`);

  console.log(`Calculating amountOut to sell with profit ${exitStrategy.targetProfit * 100}%`);

  const estimatedProfit = await waitForProfitOrTimeout(
    spentAmount,
    exitStrategy.targetProfit,
    connection,
    amountToSell,
    WSOL_TOKEN,
    pool,
    exitStrategy.exitTimeoutInMillis)

  let { confirmedTxId, error } = await sellAndConfirm(connection, pool, mainTokenAccountAddress, shitcoinAccountAddress, amountToSell)

  if (confirmedTxId === null) {
    console.log(`Failed to sell with error ${error}`)
    console.log('Retry')
    const retryResults = await sellAndConfirm(connection, pool, mainTokenAccountAddress, shitcoinAccountAddress, amountToSell)
    confirmedTxId = retryResults.confirmedTxId
    error = retryResults.error
  }

  if (confirmedTxId === null) {
    console.log(`Failed to retry sell with error ${error}`)
    console.log(`Stopping`)
    return { kind: 'FAILED', txId: confirmedTxId, reason: error ?? 'Unknown' }
  }

  console.log(`Selling transaction ${chalk.green('CONFIRMED')}. https://solscan.io/tx/${confirmedTxId}`);

  const soldForSOLAmount = await getSOLAmount(connection, confirmedTxId)
  const finalProfit = (soldForSOLAmount - spentAmount) / spentAmount

  return { kind: 'SUCCESS', txId: confirmedTxId, soldForSOL: soldForSOLAmount, estimatedProfit, profit: finalProfit }
}


async function sellAndConfirm(
  connection: Connection,
  pool: LiquidityPoolKeysV4,
  mainTokenAccountAddress: PublicKey,
  shitcoinAccountAddress: PublicKey,
  amountToSell: TokenAmount): Promise<{ confirmedTxId: string | null, error: string | null }> {

  let txid = ''
  let sellError = ''
  try {
    txid = await retryAsyncFunction(swapTokens,
      [connection,
        pool,
        mainTokenAccountAddress,
        shitcoinAccountAddress,
        PAYER,
        amountToSell])
  } catch (e) {
    console.log(chalk.red(`Failed to buy shitcoin with error ${e}. Retrying.`));
    sellError = `${e}`
  }

  if (txid === '') {
    return { confirmedTxId: null, error: sellError }
  }

  console.log(`${chalk.yellow(`Confirming selliing transaction. https://solscan.io/tx/${txid}`)}`);

  let transactionConfirmed = false
  let confirmationError = ''
  try {
    const transactionConfirmation = await retryAsyncFunction(getTransactionConfirmation, [connection, txid], 5, 300)
    if (transactionConfirmation.err) {
      confirmationError = `${transactionConfirmation.err}`
    } else {
      transactionConfirmed = true
    }
  } catch (e) {
    confirmationError = `${e}`
  }

  return { confirmedTxId: transactionConfirmed ? txid : null, error: confirmationError === '' ? null : confirmationError }
}

interface SPLTransferInfo {
  amount: string
  authority: string
  destination: string
  source: string
}

async function getSOLAmount(connection: Connection, sellTxId: string): Promise<number> {
  const parsedTx = await getParsedTxWithMeta(connection, sellTxId)
  if (parsedTx === null) {
    return 0
  }

  const inner = parsedTx.meta?.innerInstructions
  if (!inner) { return 0 }

  const splTransferPairs = inner.map(x => x.instructions.filter((a: any) => a.program === 'spl-token'))
  const splTransferPair = splTransferPairs.find(x => x.length >= 2)

  if (splTransferPair) {
    const outInfo: SPLTransferInfo = (splTransferPair[1] as any).parsed.info
    const solAmount = Number(outInfo.amount) / (10 ** WSOL.decimals)
    return solAmount
  }
  return 0
}

async function getParsedTxWithMeta(connection: Connection, txId: string): Promise<ParsedTransactionWithMeta | null> {
  let result: ParsedTransactionWithMeta | null = null
  const maxAttempts = 5
  let attempt = 1
  while (attempt <= maxAttempts) {
    result = await connection.getParsedTransaction(txId, { maxSupportedTransactionVersion: 0 })
    if (result !== null) {
      return result
    }
    attempt += 1
  }
  return result
}