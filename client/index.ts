import * as dotenv from 'dotenv';
dotenv.config();
import RaydiumSwap from './RaydiumSwap'
import { Connection, Transaction, VersionedTransaction, TokenBalance, PublicKey } from '@solana/web3.js'
import { printTime } from './Utils';
import { runNewPoolObservation } from './RaydiumNewPool'
import { LiquidityPoolKeys } from "@raydium-io/raydium-sdk";

const OWNER_ADDRESS = new PublicKey(process.env.WALLET_PUBLIC_KEY!);
const SOL = 'So11111111111111111111111111111111111111112';
const JUP = 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN';

const connection = new Connection(process.env.RPC_URL!, {
  wsEndpoint: process.env.WS_URL!
});

const raydiumSwap = new RaydiumSwap(connection, process.env.WALLET_PRIVATE_KEY!);

const swap = async (tokenAAddress: string, tokenBAddress: string, pool: LiquidityPoolKeys) => {
  const swapStartDate = new Date();
  const executeSwap = true // Change to true to execute swap
  const useVersionedTransaction = false // Use versioned transaction
  const tokenAAmount = 0.01 // e.g. 0.01 SOL -> B_TOKEN

  // const tokenAAddress = SOL // e.g. SOLANA mint address
  //const tokenBAddress = 'HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3RKwX8eACQBCt3' // e.g. PYTH mint address

  const poolInfo = pool //raydiumSwap.findPoolInfoForTokens(tokenAAddress, tokenBAddress)
  if (poolInfo === null) {
    console.error("No Pool Info");
    return;
  }
  console.log('Found pool info')

  const tx = await raydiumSwap.getSwapTransaction(
    tokenBAddress,
    tokenAAmount,
    poolInfo,
    100000, // Max amount of lamports
    useVersionedTransaction,
    'in'
  )

  if (executeSwap) {
    const txid = useVersionedTransaction
      ? await raydiumSwap.sendVersionedTransaction(tx as VersionedTransaction)
      : await raydiumSwap.sendLegacyTransaction(tx as Transaction)

    const swapEndDate = new Date();
    console.log(`https://solscan.io/tx/${txid}`)
    const swapBackStartDate = new Date();
    let newBalance: TokenBalance
    let retryCount = 0
    while (true) {
      if (retryCount > 50) {
        console.log("Most likely transaction has failed");
        return;
      }
      const b = await raydiumSwap.getNewTokenBalance(txid, tokenBAddress);
      if (b !== undefined) {
        newBalance = b;
        break;
      }
      retryCount += 1;
    }

    console.log("Shiticoins amount: " + newBalance.uiTokenAmount.uiAmountString ?? "");
    const amountToSwapBack = newBalance.uiTokenAmount.uiAmount ?? 0.0;
    const txToSwapback = await raydiumSwap.getSwapTransaction(
      tokenAAddress,
      amountToSwapBack,
      poolInfo,
      100000, // Max amount of lamports
      useVersionedTransaction,
      'in'
    )

    const swapBackTxid = useVersionedTransaction
      ? await raydiumSwap.sendVersionedTransaction(txToSwapback as VersionedTransaction)
      : await raydiumSwap.sendLegacyTransaction(txToSwapback as Transaction)


    console.log(`Swap Back https://solscan.io/tx/${swapBackTxid}`)
    let finalBalance = await connection.getBalance(OWNER_ADDRESS);
    // while (true) {
    //   const b = await raydiumSwap.getNewTokenBalance(swapBackTxid, tokenAAddress);
    //   if (b !== undefined) {
    //     finalBalance = b;
    //     break;
    //   }
    // }
    const swapBackEndDate = new Date();
    console.log(`Final sol balance: ${finalBalance}`)
    console.log("Swap Back");
    printTime(swapStartDate);
    printTime(swapEndDate);
    console.log("Swap Out");
    printTime(swapBackStartDate);
    printTime(swapBackEndDate);
  } else {
    const simRes = useVersionedTransaction
      ? await raydiumSwap.simulateVersionedTransaction(tx as VersionedTransaction)
      : await raydiumSwap.simulateLegacyTransaction(tx as Transaction)

    console.log(simRes)
  }
}

let isSwapping = false;
async function main() {
  runNewPoolObservation(connection, async (tokenA, tokenB, pool) => {
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