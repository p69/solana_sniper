import { Connection, PublicKey, TokenAmount as TA } from '@solana/web3.js'
import { TOKEN_PROGRAM_ID } from '@solana/spl-token'
import { LiquidityPoolKeysV4, Token, TokenAmount, WSOL } from "@raydium-io/raydium-sdk"
import { Wallet } from '@project-serum/anchor'
import chalk from 'chalk'
import { calculateAmountOut, swapTokens } from '../Swap'
import { getNewTokenBalance, getTransactionConfirmation, lamportsToSOLNumber, retryAsyncFunction } from '../Utils'
import { config } from '../Config'

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


  let buyError = ''
  let txid = ''
  let newTokenAmount: number | null = null
  if (config.simulateOnly) {
    try {
      newTokenAmount = await retryAsyncFunction(calcTokemAmountOut, [connection, buyAmount, tokenToBuy, poolInfo])
    } catch (e) {
      console.log(chalk.red(`Failed to simulate buying shitcoin with error ${e}. Retrying.`));
      buyError = `${e}`
    }
  } else {
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
  }


  let transactionConfirmed = newTokenAmount !== null
  let confirmationError = ''
  if (!config.simulateOnly) {
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
  }

  let snipedAmount: number | null
  if (!config.simulateOnly) {
    console.log(`Buying transaction ${chalk.green('CONFIRMED')}. https://solscan.io/tx/${txid}`);
    console.log(`Getting bought tokens amount`);
    const shitTokenBalance = await retryAsyncFunction(getNewTokenBalance,
      [connection, txid, tokenToBuy.mint.toString(), payer.publicKey.toString()], 10, 1000);

    if (shitTokenBalance !== undefined) {
      snipedAmount = shitTokenBalance.uiTokenAmount.uiAmount;
    } else {
      console.log(`${chalk.red("Couldn't fetch new balance. Trying to fetch account with balance")}`)
      const balance = await retryAsyncFunction(getTokenAccountBalance, [connection, tokenToBuyAccountAddress])
      snipedAmount = balance.uiAmount
    }
  } else {
    snipedAmount = newTokenAmount
  }

  if (snipedAmount) {
    return { kind: 'SUCCESS', newTokenAmount: snipedAmount }
  } else {
    return { kind: 'NO_TOKENS_AMOUNT', reason: 'Unknown' }
  }
}

// Don't buy, just simulate
async function calcTokemAmountOut(
  connection: Connection,
  amountIn: TokenAmount,
  tokenOut: Token,
  poolKeys: LiquidityPoolKeysV4): Promise<number | null> {
  try {
    const {
      amountOut,
      minAmountOut,
      currentPrice,
      executionPrice,
      priceImpact,
      fee,
    } = await calculateAmountOut(connection, amountIn, tokenOut, poolKeys)
    console.log(chalk.yellow('Calculated buy prices'));
    console.log(`${chalk.bold('current price: ')}: ${currentPrice.toFixed()}`);
    if (executionPrice !== null) {
      console.log(`${chalk.bold('execution price: ')}: ${executionPrice.toFixed()}`);
    }
    console.log(`${chalk.bold('price impact: ')}: ${priceImpact.toFixed()}`);
    console.log(`${chalk.bold('amount out: ')}: ${amountOut.toFixed()}`);
    console.log(`${chalk.bold('min amount out: ')}: ${minAmountOut.toFixed()}`);

    const amountOutNumber = lamportsToSOLNumber(amountOut.raw, tokenOut.decimals) ?? 0

    return amountOutNumber
  } catch (e) {
    console.log(chalk.yellow('Faiiled to calculate amountOut'));
    return null;
  }
}

async function getTokenAccountBalance(connection: Connection, tokenAccountAddress: PublicKey): Promise<TA> {
  const balance = (await connection.getTokenAccountBalance(tokenAccountAddress)).value
  return balance
}