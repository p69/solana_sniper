import { Connection, PublicKey, ParsedInstruction, PartiallyDecodedInstruction } from "@solana/web3.js";
import { printTime } from "./Utils";
import { Liquidity, LiquidityPoolKeys, Market } from "@raydium-io/raydium-sdk";
const RAYDIUM_PUBLIC_KEY = ('675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8');
const raydium = new PublicKey(RAYDIUM_PUBLIC_KEY);
import chalk from 'chalk';
// const connection = new Connection(process.env.RPC_URL!, {
//   wsEndpoint: process.env.WS_URL!
// });

let processedSignatures = new Set();

async function main(connection: Connection, raydium: PublicKey, onNewPair: (tokenSource: string, tokenDestination: string, pool: LiquidityPoolKeys) => void) {
  console.log(`${chalk.cyan('Monitoring logs...')} ${chalk.bold(raydium.toString())}`);
  connection.onLogs(raydium, async ({ logs, err, signature }) => {
    if (err) return;
    if (logs && logs.some(log => log.includes('initialize2') && !processedSignatures.has(signature))) {
      processedSignatures.add(signature);
      console.log('Signature for Initialize2:', signature);
      printTime(new Date());
      const tokens = await fetchRaydiumAccounts(signature, connection);
      if (tokens === null) {
        return
      }
      const [tokenA, tokenB, pool] = tokens
      onNewPair(tokenA, tokenB, pool);
    }
  }, "finalized");
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
export async function runNewPoolObservation(onNewPair: (tokenSource: string, tokenDestination: string, pool: LiquidityPoolKeys) => void) {
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

//runProgram().catch(console.error);