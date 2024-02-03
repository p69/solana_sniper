import * as dotenv from 'dotenv';
dotenv.config();
import RaydiumSwap from './RaydiumSwap'
import { Connection, Transaction, VersionedTransaction } from '@solana/web3.js'
import { printTime } from './Utils';
import { runNewPoolObservation } from './RaydiumNewPool'

const SOL = 'So11111111111111111111111111111111111111112';

const connection = new Connection(process.env.RPC_URL!, {
  wsEndpoint: process.env.WS_URL!
});

const raydiumSwap = new RaydiumSwap(connection, process.env.WALLET_PRIVATE_KEY!);

const swap = async (tokenBAddress: string) => {
  const swapStartDate = new Date();
  const executeSwap = true // Change to true to execute swap
  const useVersionedTransaction = false // Use versioned transaction
  const tokenAAmount = 0.01 // e.g. 0.01 SOL -> B_TOKEN

  const tokenAAddress = 'So11111111111111111111111111111111111111112' // e.g. SOLANA mint address
  //const tokenBAddress = 'HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3RKwX8eACQBCt3' // e.g. PYTH mint address

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
    printTime(swapStartDate);
    printTime(swapEndDate);
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
  await raydiumSwap.loadPoolKeys()
  console.log(`Loaded pool keys`)

  runNewPoolObservation(connection, (tokenA, tokenB) => {
    if (isSwapping) {
      return;
    }

    if (tokenA === SOL) {
      isSwapping = true;
      //swap(tokenB);
    }

    if (tokenB === SOL) {
      isSwapping = true;
      //swap(tokenA);
    }
    console.log("swap completed");
  });
};
//swap()
main().catch(console.error);