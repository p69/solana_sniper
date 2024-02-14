import { Connection, PublicKey, TokenAmount as TA } from '@solana/web3.js'
import { TOKEN_PROGRAM_ID } from '@solana/spl-token'
import { LiquidityPoolKeysV4, Token, TokenAmount, WSOL } from "@raydium-io/raydium-sdk"
import { Wallet } from '@project-serum/anchor'
import chalk from 'chalk'
import { swapTokens } from '../Swap'
import { getNewTokenBalance, getTransactionConfirmation, retryAsyncFunction } from '../Utils'

const WSOL_TOKEN = new Token(TOKEN_PROGRAM_ID, WSOL.mint, WSOL.decimals)

interface Success {
  kind: 'SUCCESS',
  newTokenAmount: number
}

interface FailedToBuy {
  kind: 'NO_BUY',
  reason: string
}

interface NoConfirmation {
  kind: 'NO_CONFIRMATION',
  reason: string,
  txId: string
}

interface FailedToGetBoughtTokensAmount {
  kind: 'NO_TOKENS_AMOUNT',
  reason: string
}

export type BuyResult = Success | FailedToBuy | NoConfirmation | FailedToGetBoughtTokensAmount


export async function buyToken(
  connection: Connection,
  payer: Wallet,
  amountToBuy: number,
  tokenToBuy: Token,
  tokenToBuyAccountAddress: PublicKey,
  poolInfo: LiquidityPoolKeysV4,
  mainTokenAccountAddress: PublicKey): Promise<BuyResult> {
  const buyAmount = new TokenAmount(WSOL_TOKEN, amountToBuy, false)

  console.log(chalk.yellow(`Getting trend before buying a token`));


  console.log(`Buying ${tokenToBuy.mint} for ${amountToBuy} SOL`);

  let txid = ''
  let buyError = ''
  try {
    txid = await retryAsyncFunction(swapTokens,
      [connection,
        poolInfo,
        mainTokenAccountAddress,
        tokenToBuyAccountAddress,
        payer,
        buyAmount])
  } catch (e) {
    console.log(chalk.red(`Failed to buy shitcoin with error ${e}. Retrying.`));
    buyError = `${e}`
  }

  if (txid === '') {
    return { kind: 'NO_BUY', reason: buyError }
  }

  console.log(`${chalk.yellow(`Confirming buying transaction. https://solscan.io/tx/${txid}`)}`);

  let transactionConfirmed = false
  let confirmationError = ''
  try {
    const transactionConfirmation = await retryAsyncFunction(getTransactionConfirmation, [connection, txid], 10, 1000)
    if (transactionConfirmation.err) {
      confirmationError = `${transactionConfirmation.err}`
    } else {
      transactionConfirmed = true
    }
  } catch (e) {
    confirmationError = `${e}`
  }

  if (!transactionConfirmed) {
    console.log(chalk.red(`Couldn't confirm transaction https://solscan.io/tx/${txid}`))
    return { kind: 'NO_CONFIRMATION', reason: confirmationError, txId: txid }
  }

  console.log(`Buying transaction ${chalk.green('CONFIRMED')}. https://solscan.io/tx/${txid}`);
  console.log(`Getting bought tokens amount`);

  const shitTokenBalance = await retryAsyncFunction(getNewTokenBalance,
    [connection, txid, tokenToBuy.mint.toString(), payer.publicKey.toString()], 10, 1000);
  let snipedAmount: number | null
  if (shitTokenBalance !== undefined) {
    snipedAmount = shitTokenBalance.uiTokenAmount.uiAmount;
  } else {
    console.log(`${chalk.red("Couldn't fetch new balance. Trying to fetch account with balance")}`)
    const balance = await retryAsyncFunction(getTokenAccountBalance, [connection, tokenToBuyAccountAddress])
    snipedAmount = balance.uiAmount
  }

  if (snipedAmount) {
    return { kind: 'SUCCESS', newTokenAmount: snipedAmount }
  } else {
    return { kind: 'NO_TOKENS_AMOUNT', reason: 'Unknown' }
  }
}

async function getTokenAccountBalance(connection: Connection, tokenAccountAddress: PublicKey): Promise<TA> {
  const balance = (await connection.getTokenAccountBalance(tokenAccountAddress)).value
  return balance
}