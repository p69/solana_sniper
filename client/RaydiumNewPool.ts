import { Connection, PublicKey, ParsedTransactionWithMeta, PartiallyDecodedInstruction, Logs } from "@solana/web3.js";
import { delay, formatDate, printTime } from "./Utils";
import { Liquidity, LiquidityPoolKeys, LiquidityPoolKeysV4, Market, WSOL } from "@raydium-io/raydium-sdk";
const RAYDIUM_PUBLIC_KEY = '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8';
const raydium = new PublicKey(RAYDIUM_PUBLIC_KEY);
import chalk from 'chalk';
import { fetchPoolKeysForLPInitTransactionHash, findLogEntry } from "./PoolMaker";
import { checkToken } from "./SafetyCheck";
// const connection = new Connection(process.env.RPC_URL!, {
//   wsEndpoint: process.env.WS_URL!
// });

export type PoolWithStrategy = {
  pool: LiquidityPoolKeysV4,
  exitTimeoutInMillis: number,
  targetProfit: number
}


const seenTransactions = new Set();
let poolIsProcessing = false;

const TEST_TX = '4EZJKpqCqVufrqqpKMZV2ATcJXoY7P8o47Dgw3ZkndPsojzy8EFG2stiJcgYDT9skCUcG4Jrr2kmAnskR1FcMTFh'


async function handleNewTxLog(connection: Connection, txId: string): Promise<PoolWithStrategy | null> {
  try {
    const date = new Date();
    const { poolKeys, mintTransaction } = await fetchPoolKeysForLPInitTransactionHash(txId, connection); // With poolKeys you can do a swap
    console.log(`Found new POOL at ${chalk.bgYellow(formatDate(date))}`);
    console.log(`${poolKeys.id}`);
    const safetyCheckResults = await checkToken(connection, mintTransaction, poolKeys)

    if (safetyCheckResults === null) {
      console.log(chalk.red(`Couldn't verify safety for pool ${poolKeys.id}. Skipping`))
      return null
    }

    const SAFE_LOCKED_LIQUIDITY_PERCENT = 0.9
    if (safetyCheckResults.lockedPercentOfLiqiodity < SAFE_LOCKED_LIQUIDITY_PERCENT) {
      console.log(chalk.red(`Too much liquidity is unlocked ${1 - safetyCheckResults.lockedPercentOfLiqiodity}. RUN AWAY`))
      return null
    }

    const info = await Liquidity.fetchInfo({ connection: connection, poolKeys: poolKeys });
    const features = Liquidity.getEnabledFeatures(info);

    if (!features.swap) {
      console.log(`${chalk.gray(`Swapping is disabled, skipping`)}`);
      return null
    }

    const LOW_IN_USD = 1000;
    const HIGH_IN_USD = 100000000;
    if (safetyCheckResults.totalLiquidity.amountInUSD < LOW_IN_USD || safetyCheckResults.totalLiquidity.amountInUSD >= HIGH_IN_USD) {
      console.log(`${chalk.gray('Liquiidity is too low or too high. Dangerous. Skipping.')}`)
      return null
    }

    if (safetyCheckResults.suspiciusLargestHolder) {
      console.log(`${chalk.gray('Huge wallet is not Raydium. Dangerous. Skipping.')}`)
      return null
    }


    if (!safetyCheckResults.ownershipInfo.creatorHasAuthority) {
      console.log(`${chalk.green('Safety check passed. LFG')}`)
      return {
        pool: poolKeys,
        exitTimeoutInMillis: 10 * 60 * 1000, // 10 minutes time when token looks good
        targetProfit: 3.0 // 300% to target, we must be early to 
      }
    } else {
      console.log(`${chalk.yellowBright("All good with liquidity, but ownership wasn't renounced. Let's give it a try")}`)
      return {
        pool: poolKeys,
        exitTimeoutInMillis: 3 * 60 * 1000, // 3 minutes time when token looks good
        targetProfit: 0.3 // 30% to target, owner could dump all tokens
      }
    }
  } catch (e) {
    console.error(`Couldn't fetch or verify TX ${chalk.yellow(txId)}. ${e}`);
    return null
  }
}

async function main(connection: Connection, raydium: PublicKey, onNewPair: (pool: PoolWithStrategy) => void) {
  /* Uncomment to test with constatnt txid */
  // await handleNewTxLog(connection, TEST_TX)
  // return

  console.log(`${chalk.cyan('Monitoring logs...')} ${chalk.bold(raydium.toString())}`);

  connection.onLogs(raydium, async (txLogs) => {
    if (poolIsProcessing) { return; }
    if (seenTransactions.has(txLogs.signature)) {
      return;
    }
    seenTransactions.add(txLogs.signature);
    if (!findLogEntry('init_pc_amount', txLogs.logs)) {
      return; // If "init_pc_amount" is not in log entries then it's not LP initialization transaction
    }
    poolIsProcessing = true
    console.log(chalk.yellow(`Fetching mint tx - ${txLogs.signature}`))
    let poolWithStrategy
    try {
      poolWithStrategy = await handleNewTxLog(connection, txLogs.signature)
    } catch (e) {
      await delay(200)
      poolWithStrategy = await handleNewTxLog(connection, txLogs.signature)
    }

    if (poolWithStrategy !== null) { onNewPair(poolWithStrategy) }
    poolIsProcessing = false
  });
  console.log('Listening to new pools...');

  // connection.onLogs(raydium, async ({ logs, err, signature }) => {
  //   if (err) return;
  //   if (logs && logs.some(log => log.includes('initialize2') && !processedSignatures.has(signature))) {
  //     processedSignatures.add(signature);
  //     console.log('Signature for Initialize2:', signature);
  //     printTime(new Date());
  //     const tokens = await fetchRaydiumAccounts(signature, connection);
  //     if (tokens === null) {
  //       return
  //     }
  //     const [tokenA, tokenB, pool] = tokens
  //     onNewPair(tokenA, tokenB, pool);
  //   }
  // }, "finalized");
}

async function fetchRaydiumAccounts(signature: string, connection: Connection): Promise<[string, string, LiquidityPoolKeys] | null> {
  const txId = signature;
  const tx = await connection.getParsedTransaction(txId, { maxSupportedTransactionVersion: 0, commitment: "confirmed" });
  console.log(`Pool creation transaction: ${tx}`);
  const transaction = tx?.transaction?.message?.instructions.find(ix => ix.programId.toBase58() === RAYDIUM_PUBLIC_KEY)
  if (transaction === undefined) {
    console.log("Transaction not found")
    return null
  }
  const instruction = tx?.transaction?.message?.instructions.find(ix => ix.programId.toBase58() === RAYDIUM_PUBLIC_KEY) as PartiallyDecodedInstruction
  const accounts = instruction?.accounts;
  const innerInstructions = tx?.meta?.innerInstructions ?? []
  const allInstructions = innerInstructions.flatMap(x => x.instructions);
  const marketInstruction = allInstructions.find((x) => {
    const parsedInstr = (x as any);
    if (parsedInstr.parsed?.info?.space !== undefined) {
      return parsedInstr.parsed?.info?.space === 752;
    }
    return false;
  });
  const marketAddress = new PublicKey((marketInstruction as any).parsed.info.account);

  if (!accounts) {
    console.log('No accounts found');
    return null;
  }
  const tokenAIndex = 8;
  const tokenBIndex = 9;

  const tokeAAccount = accounts[tokenAIndex];
  const tokenBAccount = accounts[tokenBIndex];
  const displayData = [
    { Token: 'Token A', account: tokeAAccount },
    { Token: 'Token B', account: tokenBAccount },
  ];

  const poolKey = await fetchPoolKeys(connection, marketAddress);

  console.log("New Raydium Liquidity Pool Created Found");
  printTime(new Date());
  console.log(generateExplorerUrl(txId));
  console.table(displayData);
  // await sleep(2000);
  return [tokeAAccount.toString(), tokenBAccount.toString(), poolKey];
}

function generateExplorerUrl(txId: string) {
  return `https://solscan.io/tx/${txId}?cluster=mainnet`;
}

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export async function fetchPoolKeys(
  connection: Connection,
  poolId: PublicKey,
  version: 4 | 5 = 4): Promise<LiquidityPoolKeys> {

  const serumVersion = 10
  const marketVersion: 3 = 3

  const programId = new PublicKey('675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8');
  const serumProgramId = new PublicKey('srmqPvymJeFKQ4zGQed1GFppgkRHL9kaELCbyksJtPX')

  const account = await connection.getAccountInfo(poolId)
  const { state: LiquidityStateLayout } = Liquidity.getLayouts(version)

  //@ts-ignore
  const fields = LiquidityStateLayout.decode(account?.data);
  const { status, baseMint, quoteMint, lpMint, openOrders, targetOrders, baseVault, quoteVault, marketId, baseDecimal, quoteDecimal, } = fields;

  let withdrawQueue, lpVault;
  if (Liquidity.isV4(fields)) {
    withdrawQueue = fields.withdrawQueue;
    lpVault = fields.lpVault;
  } else {
    withdrawQueue = PublicKey.default;
    lpVault = PublicKey.default;
  }

  // uninitialized
  // if (status.isZero()) {
  //   return ;
  // }

  const associatedPoolKeys = Liquidity.getAssociatedPoolKeys({
    version: version,
    marketVersion,
    marketId,
    baseMint: baseMint,
    quoteMint: quoteMint,
    baseDecimals: baseDecimal.toNumber(),
    quoteDecimals: quoteDecimal.toNumber(),
    programId,
    marketProgramId: serumProgramId,
  });

  const poolKeys = {
    id: poolId,
    baseMint,
    quoteMint,
    lpMint,
    baseDecimals: associatedPoolKeys.baseDecimals,
    quoteDecimals: associatedPoolKeys.quoteDecimals,
    lpDecimals: associatedPoolKeys.lpDecimals,
    lookupTableAccount: associatedPoolKeys.lookupTableAccount,
    version,
    programId,
    authority: associatedPoolKeys.authority,
    openOrders,
    targetOrders,
    baseVault,
    quoteVault,
    withdrawQueue,
    lpVault,
    marketProgramId: serumProgramId,
    marketId,
    marketAuthority: associatedPoolKeys.marketAuthority,
  };



  const marketInfo = await connection.getAccountInfo(marketId);
  const { state: MARKET_STATE_LAYOUT } = Market.getLayouts(marketVersion);
  //@ts-ignore
  const market = MARKET_STATE_LAYOUT.decode(marketInfo.data);

  const {
    baseVault: marketBaseVault,
    quoteVault: marketQuoteVault,
    bids: marketBids,
    asks: marketAsks,
    eventQueue: marketEventQueue,
  } = market;

  // const poolKeys: LiquidityPoolKeys;
  return {
    ...poolKeys,
    marketVersion: 3,
    ...{
      marketBaseVault,
      marketQuoteVault,
      marketBids,
      marketAsks,
      marketEventQueue,
    },
  };
}


// main(connection,raydium).catch(console.error);
export async function runNewPoolObservation(onNewPair: (pool: PoolWithStrategy) => void) {
  const connection = new Connection(process.env.RPC_URL!, {
    wsEndpoint: process.env.WS_URL!
  });
  await main(connection, raydium, onNewPair);
  // try {
  //   await main(connection, raydium);
  // } catch (error) {
  //   console.error(`Error occurred: ${error}`);
  //   console.log('Restarting the program...');
  //   runNewPoolObservation();
  // }
}

export function setPoolProcessed() {
  poolIsProcessing = false;
}

//runProgram().catch(console.error);