import * as dotenv from 'dotenv';
dotenv.config();
import RaydiumSwap from './RaydiumSwap'
import { Connection, Transaction, VersionedTransaction, TokenBalance } from '@solana/web3.js'
import { printTime } from './Utils';
import { runNewPoolObservation } from './RaydiumNewPool'

const SOL = 'So11111111111111111111111111111111111111112';
const JUP = 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN';

const connection = new Connection(process.env.RPC_URL!, {
  wsEndpoint: process.env.WS_URL!
});

const raydiumSwap = new RaydiumSwap(connection, process.env.WALLET_PRIVATE_KEY!);

const swap = async (tokenAAddress: string, tokenBAddress: string) => {
  const swapStartDate = new Date();
  const executeSwap = true // Change to true to execute swap
  const useVersionedTransaction = false // Use versioned transaction
  const tokenAAmount = 0.01 // e.g. 0.01 SOL -> B_TOKEN

  // const tokenAAddress = SOL // e.g. SOLANA mint address
  //const tokenBAddress = 'HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3RKwX8eACQBCt3' // e.g. PYTH mint address

  await raydiumSwap.loadPoolKeys()
  console.log(`Loaded pool keys`)

  // Trying to find pool info in the json we loaded earlier and by comparing baseMint and tokenBAddress
  const poolInfo = raydiumSwap.findPoolInfoForTokens(tokenAAddress, tokenBAddress)
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
    while (true) {
      const b = await raydiumSwap.getNewTokenBalance(txid, tokenBAddress);
      if (b !== undefined) {
        newBalance = b;
        break;
      }
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
    let finalBalance: TokenBalance
    while (true) {
      const b = await raydiumSwap.getNewTokenBalance(swapBackTxid, tokenAAddress);
      if (b !== undefined) {
        finalBalance = b;
        break;
      }
    }
    const swapBackEndDate = new Date();
    console.log(`Final sol balance: ${finalBalance.uiTokenAmount.uiAmountString}`)
    console.log("Swap In");
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
  // Loading with pool keys from https://api.raydium.io/v2/sdk/liquidity/mainnet.json

  // swap(JUP).catch(console.error);

  runNewPoolObservation(connection, (tokenA, tokenB) => {
    if (isSwapping) {
      return;
    }

    console.log(`Verify tokens A - ${tokenA}   B - ${tokenB}`);

    if (tokenA === SOL) {
      isSwapping = true;
      console.log("Start swapping");
      swap(tokenA, tokenB);
    } else if (tokenB === SOL) {
      isSwapping = true;
      console.log("Start swapping");
      swap(tokenB, tokenA);
    } else {
      console.log("No SOL tokens. Skip");
    }

  });
};
//swap()
main().catch(console.error);