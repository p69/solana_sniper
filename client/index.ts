import * as dotenv from 'dotenv';
dotenv.config();
import RaydiumSwap from './RaydiumSwap'
import { Connection, Transaction, VersionedTransaction, TokenBalance, PublicKey } from '@solana/web3.js'
import { formatDate, printTime } from './Utils';
import { runNewPoolObservation } from './RaydiumNewPool'
import { LiquidityPoolKeys, LiquidityPoolKeysV4, Percent } from "@raydium-io/raydium-sdk";
import chalk from 'chalk';
import { ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID, NATIVE_MINT } from '@solana/spl-token';

const OWNER_ADDRESS = new PublicKey(process.env.WALLET_PUBLIC_KEY!);
const SOL = 'So11111111111111111111111111111111111111112';
const JUP = 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN';
const BUY_AMOUNT_IN_SOL = 0.01 // e.g. 0.01 SOL -> B_TOKEN

const [SOL_SPL_TOKEN_ADDRESS] = PublicKey.findProgramAddressSync(
  [OWNER_ADDRESS.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), NATIVE_MINT.toBuffer()],
  ASSOCIATED_TOKEN_PROGRAM_ID
);

const connection = new Connection(process.env.RPC_URL!, {
  wsEndpoint: process.env.WS_URL!
});

const raydiumSwap = new RaydiumSwap(connection, process.env.WALLET_PRIVATE_KEY!);

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

  console.log(`Buying finished. Started at ${formatDate(swapStartDate)}, finished at ${formatDate(swapEndDate)}`);
  console.log(`Getting BUY transaction details https://solscan.io/tx/${txid}`);

  let newBalance: TokenBalance
  let retryCount = 0
  while (true) {
    if (retryCount > 50) {
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

  console.log(`Selling finished. Started at ${formatDate(swapStartDate)}, finished at ${formatDate(swapEndDate)}`);
  console.log(`Getting SELL transaction details https://solscan.io/tx/${txid}`);

  let retryCount = 0
  while (true) {
    if (retryCount > 50) {
      console.log(`Most likely SELL transaction has ${chalk.red("FAILED")} https://solscan.io/tx/${txid}`);
      return -1;
    }
    const response = await connection.getTransaction(txid, { "maxSupportedTransactionVersion": 0 });
    if (response?.transaction !== null && response?.meta !== null) {
      console.log(`SELL transaction ${chalk.green("CONFIRMED")} https://solscan.io/tx/${txid}`);
      break;
    }
    retryCount += 1;
  }


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
  const finalSOLBalance = await sellShitcoin(swappedShitcoinsAmount, tokenAAddress, poolInfo);
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

let isSwapping = false;
async function main() {
  runNewPoolObservation(async (tokenA, tokenB, pool) => {
    if (isSwapping) {
      return;
    }

    console.log(`Verify tokens A - ${tokenA}   B - ${tokenB}`);

    if (tokenA === SOL) {
      isSwapping = true;
      console.log("Start swapping");
      await swap(tokenA, tokenB, pool);
      isSwapping = false;
    } else if (tokenB === SOL) {
      isSwapping = true;
      console.log("Start swapping");
      await swap(tokenB, tokenA, pool);
      isSwapping = false;
    } else {
      console.log("No SOL tokens. Skip");
    }

  });
};
//swap()
main().catch(console.error);