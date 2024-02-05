import * as dotenv from 'dotenv';
dotenv.config();
import RaydiumSwap from './RaydiumSwap'
import { Connection, Transaction, VersionedTransaction, TokenBalance, PublicKey, SignatureResult } from '@solana/web3.js'
import { formatDate, timeout } from './Utils';
import { runNewPoolObservation, fetchPoolKeys } from './RaydiumNewPool'
import { LiquidityPoolKeys, LiquidityPoolKeysV4, Percent } from "@raydium-io/raydium-sdk";
import chalk from 'chalk';
import { ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID, NATIVE_MINT } from '@solana/spl-token';

const OWNER_ADDRESS = new PublicKey(process.env.WALLET_PUBLIC_KEY!);
const SOL = 'So11111111111111111111111111111111111111112';
const JUP = 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN';
const JUP_MARKET_ID = '7WMCUyZXrDxNjAWjuh2r7g8CdT2guqvrmdUPAnGdLsfG';
const BUY_AMOUNT_IN_SOL = 0.01 // e.g. 0.01 SOL -> B_TOKEN

const [SOL_SPL_TOKEN_ADDRESS] = PublicKey.findProgramAddressSync(
  [OWNER_ADDRESS.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), NATIVE_MINT.toBuffer()],
  ASSOCIATED_TOKEN_PROGRAM_ID
);

const connection = new Connection(process.env.RPC_URL!, {
  wsEndpoint: process.env.WS_URL!
});

const raydiumSwap = new RaydiumSwap(connection, process.env.WALLET_PRIVATE_KEY!);

async function getTransactionConfirmation(txid: string): Promise<SignatureResult> {
  const confirmResult = await connection.confirmTransaction({ signature: txid, ...(await connection.getLatestBlockhash()) }, 'confirmed');
  return confirmResult.value;
}

async function confirmTransaction(txid: string): Promise<boolean> {
  try {
    const confirmResult = await Promise.race([
      getTransactionConfirmation(txid),
      timeout(15 * 1000)
    ])
    const transactionFailed = confirmResult.err !== null;
    if (transactionFailed) {
      console.log(`Buying transaction ${chalk.bold(txid)} ${chalk.red('FAILED')}. Error: ${chalk.redBright(confirmResult.err)}`);
      return false;
    }
    return true;
  } catch (e) {
    console.log(`Buying transaction ${chalk.bold(txid)} ${chalk.red('FAILED')}. Error: ${chalk.redBright(e)}`);
    return false;
  }
}

async function buyShitcoin(shitcoinAddress: string, poolInfo: LiquidityPoolKeysV4): Promise<number> {
  console.log(`Buying ${shitcoinAddress} for ${BUY_AMOUNT_IN_SOL} SOL`);
  const swapStartDate = new Date();

  const tx = await raydiumSwap.getSwapTransaction(
    shitcoinAddress,
    BUY_AMOUNT_IN_SOL,
    poolInfo,
    100000, // Max amount of lamports
    true,
    'in'
  );

  const txid = await raydiumSwap.sendVersionedTransaction(tx as VersionedTransaction);
  const swapEndDate = new Date();

  console.log(`Confirming buying transaction. https://solscan.io/tx/${txid}`);

  const transactionConfirmed = await confirmTransaction(txid);
  if (!transactionConfirmed) {
    return -1;
  }

  console.log(`Buying transaction ${chalk.green('CONFIRMED')}. https://solscan.io/tx/${txid}`);

  console.log(`Buying finished. Started at ${formatDate(swapStartDate)}, finished at ${formatDate(swapEndDate)}`);
  console.log(`Getting bought tokens amount`);

  let newBalance: TokenBalance
  let retryCount = 0
  while (true) {
    if (retryCount > 10) {
      console.log("Most likely transaction has failed");
      return -1;
    }
    const b = await raydiumSwap.getNewTokenBalance(txid, shitcoinAddress);
    if (b !== undefined) {
      newBalance = b;
      break;
    }
    retryCount += 1;
  }

  console.log(`Got ${newBalance.uiTokenAmount.uiAmountString ?? ""} of shitcoins`);

  return newBalance.uiTokenAmount.uiAmount ?? 0.0;
}

//Sell shitcoins and return amount of SOL in wallet
async function sellShitcoin(amountToSell: number, mainTokenAddress: string, poolInfo: LiquidityPoolKeysV4): Promise<number> {
  console.log(`Selling ${amountToSell} shitcoins`);
  const swapStartDate = new Date();

  const tx = await raydiumSwap.getSwapTransaction(
    mainTokenAddress,
    amountToSell,
    poolInfo,
    100000, // Max amount of lamports
    true,
    'in'
  )

  const txid = await raydiumSwap.sendVersionedTransaction(tx as VersionedTransaction);
  const swapEndDate = new Date();

  console.log(`Confirming selliing transaction. https://solscan.io/tx/${txid}`);

  const transactionConfirmed = await confirmTransaction(txid);
  if (!transactionConfirmed) {
    return -1;
  }

  console.log(`Selling transaction ${chalk.green('CONFIRMED')}. https://solscan.io/tx/${txid}`);
  console.log(`Selling finished. Started at ${formatDate(swapStartDate)}, finished at ${formatDate(swapEndDate)}`);
  console.log(`Getting SELL transaction details https://solscan.io/tx/${txid}`);

  let finalBalance = await getWSOLBalance();

  return finalBalance;
}

const swap = async (tokenAAddress: string, tokenBAddress: string, pool: LiquidityPoolKeys) => {
  const originalBalanceValue = await getWSOLBalance();

  const poolInfo = pool
  if (poolInfo === null) {
    console.error("No Pool Info");
    return;
  }

  const swappedShitcoinsAmount = await buyShitcoin(tokenBAddress, poolInfo);
  if (swappedShitcoinsAmount <= 0) {
    console.log(`${chalk.red('Failed')} to BUY shiitcoins. STOP sniping`);
    return;
  }
  const afterSellSOLBalance = await sellShitcoin(swappedShitcoinsAmount, tokenAAddress, poolInfo);
  const finalSOLBalance = afterSellSOLBalance < 0 ? (originalBalanceValue - BUY_AMOUNT_IN_SOL) : afterSellSOLBalance;
  const profit = (finalSOLBalance - originalBalanceValue) / BUY_AMOUNT_IN_SOL;
  const profitInPercent = profit * 100;
  const formatted = Number(profitInPercent.toPrecision(3));
  const finalProfitString = formatted.toFixed(1) + '%';
  console.log(`${chalk.bold("Profit: ")}: ${profit < 0 ? chalk.red(finalProfitString) : chalk.green(finalProfitString)}`);
}

async function getWSOLBalance(): Promise<number> {
  const result = await connection.getTokenAccountBalance(SOL_SPL_TOKEN_ADDRESS);
  return result.value.uiAmount ?? 0;
}

async function testWithJup() {
  const pool = await fetchPoolKeys(connection, new PublicKey(JUP_MARKET_ID));
  await swap(SOL, JUP, pool);
}

let isSwapping = false;
async function main() {
  // await testWithJup();
  // return;

  runNewPoolObservation(async (tokenA, tokenB, pool) => {
    if (isSwapping) {
      return;
    }

    console.log(`New pool ${chalk.green(pool.id.toString())}`);
    console.log(`Verify tokens A - ${tokenA}   B - ${tokenB}`);

    if (tokenA === SOL) {
      isSwapping = true;
      console.log("Start swapping");
      await swap(tokenA, tokenB, pool);
      isSwapping = false;
      console.log(`${chalk.green('DONE')} swapping. Waiting for the next pair`);
    } else if (tokenB === SOL) {
      isSwapping = true;
      console.log("Start swapping");
      await swap(tokenB, tokenA, pool);
      isSwapping = false;
      console.log(`${chalk.green('DONE')} swapping. Waiting for the next pair`);
    } else {
      console.log("No SOL tokens. Skip");
    }



  });
};
//swap()
main().catch(console.error);