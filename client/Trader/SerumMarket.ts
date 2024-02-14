import { PublicKey, ParsedTransactionWithMeta } from '@solana/web3.js'
import { getAssociatedTokenAddressSync } from '@solana/spl-token'
import { connection } from './Connection'
import { BN } from "@project-serum/anchor";
import { WSOL } from '@raydium-io/raydium-sdk';

const eventQueue = "GsKj8Mmiu6k8FCjY31jgZY9y3xEjwXgiuD42DFTgCHkf"
const openOrders = "8BKdZAafGGbxaKKLe7GvFCNFha9XJan1ZbZBT7EiwcLh"
const rPoolAcc = "5CrZMaLVzDaZiinmPYM9ntAAqsmAvH4JKAKDczYRbXdd"
const shitToken = "CUuJRwXVmne5Gqz62ao2GsyZY9rUVPy487Z9bqSCTL4c"
const poolTokenAccount = new PublicKey('BoiDCWjwLCzyKHcM4ZXEgviHjs5UphiPKMLegFeEfG1T') //getAssociatedTokenAddressSync(new PublicKey(shitToken), new PublicKey(rPoolAcc))
const poolSolAccount = getAssociatedTokenAddressSync(new PublicKey(WSOL.mint), new PublicKey('5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1'), true)
const shitTokenDecimals = 9


async function test() {
  const allTransactions = await connection.getConfirmedSignaturesForAddress2(new PublicKey(rPoolAcc), { limit: 1000 })
  const filtered = allTransactions.filter(x => !x.err)
  const trades = await connection.getParsedTransactions(filtered.map(x => x.signature), { maxSupportedTransactionVersion: 0 })
  const tradeRecords = parseTradingData(trades)
  const dumpingRecords = findDumpingRecord(tradeRecords)
  if (dumpingRecords) {
    const [beforeDump, afterDump] = dumpingRecords
  }
  console.log('loaded')
}

test()

function parseTradingData(transactions: (ParsedTransactionWithMeta | null)[]): TradeRecord[] {
  let results: TradeRecord[] = []

  for (let txOrNull of transactions) {
    if (!txOrNull) { continue }

    const inner = txOrNull.meta?.innerInstructions
    if (!inner) { continue }

    const splTransferPairs = inner.map(x => x.instructions.filter((a: any) => a.program === 'spl-token'))
    const splTransferPair = splTransferPairs.find(x => x.length === 2)

    if (splTransferPair) {
      const inInfo: SPLTransferInfo = (splTransferPair[0] as any).parsed.info
      const outInfo: SPLTransferInfo = (splTransferPair[1] as any).parsed.info
      const userShitAcc = getAssociatedTokenAddressSync(new PublicKey(shitToken), new PublicKey(inInfo.authority))
      const isSelling = inInfo.source === userShitAcc.toString()


      const shitAmount = Number(isSelling ? inInfo.amount : outInfo.amount) / (10 ** shitTokenDecimals)
      const solAmount = Number(isSelling ? outInfo.amount : inInfo.amount) / (10 ** WSOL.decimals)
      const priceInSOL = solAmount / shitAmount
      results.push({
        signature: txOrNull.transaction.signatures[0],
        date: new Date(txOrNull.blockTime ?? 0),
        type: isSelling ? 'SELL' : 'BUY',
        rawAmount: isSelling ? inInfo.amount : outInfo.amount,
        priceInSOL: priceInSOL
      })
    }
  }

  return results
}

function findDumpingRecord(data: TradeRecord[], threshold: number = 50): [TradeRecord, TradeRecord] | null {
  for (let i = data.length - 1; i > 1; i--) {
    const current = data[i];
    const next = data[i - 1];
    if (!(current.type === 'SELL' && next.type === 'BUY')) { continue }
    const percentageChange = ((next.priceInSOL - current.priceInSOL) / current.priceInSOL) * 100;

    if (percentageChange <= -threshold) return [current, next]; // Dump detected
  }
  return null; // No dump detected
}

type TradeType = 'BUY' | 'SELL'

interface TradeRecord {
  signature: string
  date: Date
  type: TradeType
  rawAmount: string
  priceInSOL: number
}

interface SPLTransferInfo {
  amount: string
  authority: string
  destination: string
  source: string
}