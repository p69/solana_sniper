import { Connection, PublicKey, ParsedInstruction, PartiallyDecodedInstruction } from "@solana/web3.js";
import { printTime } from "./Utils";
const RAYDIUM_PUBLIC_KEY = ('675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8');
const raydium = new PublicKey(RAYDIUM_PUBLIC_KEY);
const connection = new Connection('https://api.mainnet-beta.solana.com', {
  wsEndpoint: 'wss://api.mainnet-beta.solana.com'

});

let processedSignatures = new Set();

async function main(connection: Connection, raydium: PublicKey) {
  console.log('Monitoring logs...', raydium.toString());
  connection.onLogs(raydium, ({ logs, err, signature }) => {
    if (err) return;
    if (logs && logs.some(log => log.includes('initialize2') && !processedSignatures.has(signature))) {
      processedSignatures.add(signature);
      console.log('Signature for Initialize2:', signature);
      printTime(new Date());
      fetchRaydiumAccounts(signature, connection);
    }
  }, "finalized");
}

async function fetchRaydiumAccounts(signature: string, connection: Connection) {
  const txId = signature;
  const tx = await connection.getParsedTransaction(txId, { maxSupportedTransactionVersion: 0, commitment: "confirmed" });
  const transaction = tx?.transaction?.message?.instructions.find(ix => ix.programId.toBase58() === RAYDIUM_PUBLIC_KEY)
  if (transaction === undefined) {
    console.log("Transaction not found")
    return
  }
  const instruction = tx?.transaction?.message?.instructions.find(ix => ix.programId.toBase58() === RAYDIUM_PUBLIC_KEY) as PartiallyDecodedInstruction
  const accounts = instruction?.accounts;

  if (!accounts) {
    console.log('No accounts found');
    return;
  }
  const tokenAIndex = 8;
  const tokenBIndex = 9;

  const tokeAAccount = accounts[tokenAIndex];
  const tokenBAccount = accounts[tokenBIndex];
  const displayData = [
    { Token: 'Token A', account: tokeAAccount },
    { Token: 'Token B', account: tokenBAccount },
  ];
  console.log("New Raydium  Liquidity Pool Created Found");
  printTime(new Date());
  console.log(generateExplorerUrl(txId));
  console.table(displayData);
  // await sleep(2000);
}

function generateExplorerUrl(txId: string) {
  return `https://solscan.io/tx/${txId}?cluster=mainnet`;
}

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}


// main(connection,raydium).catch(console.error);
export async function runNewPoolObservation() {
  try {
    await main(connection, raydium);
  } catch (error) {
    console.error(`Error occurred: ${error}`);
    console.log('Restarting the program...');
    runNewPoolObservation();
  }
}

//runProgram().catch(console.error);