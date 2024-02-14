import { PublicKey, ParsedTransactionWithMeta, Connection } from '@solana/web3.js'
import { getAssociatedTokenAddressSync } from "@solana/spl-token"
import { WSOL } from '@raydium-io/raydium-sdk'


export type TradeType = 'BUY' | 'SELL'

export interface TradeRecord {
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

export async function fetchLatestTrades(
  connection: Connection,
  tradingPoolAddress: PublicKey,
  tokenMint: PublicKey,
  tokenDecimals: number,
  limit: number = 1000): Promise<TradeRecord[]> {
  const allTransactions = await connection.getConfirmedSignaturesForAddress2(tradingPoolAddress, { limit: limit })
  const filtered = allTransactions.filter(x => !x.err)
  const trades = await connection.getParsedTransactions(filtered.map(x => x.signature), { maxSupportedTransactionVersion: 0 })
  return parseTradingData(trades, tokenMint, tokenDecimals)
}

function parseTradingData(
  transactions: (ParsedTransactionWithMeta | null)[],
  tokenMint: PublicKey,
  tokenDecimals: number): TradeRecord[] {
  let results: TradeRecord[] = []

  try {
    for (let i = 0; i < transactions.length; i++) {
      const txOrNull = transactions[i]
      if (!txOrNull) { continue }

      const inner = txOrNull.meta?.innerInstructions
      if (!inner) { continue }

      const splTransferPairs = inner.map(x => x.instructions.filter((a: any) => a.program === 'spl-token' && a.parsed.type === 'transfer'))
      const splTransferPair = splTransferPairs.find(x => x.length >= 2)

      if (splTransferPair) {
        const inInfo: SPLTransferInfo = (splTransferPair[0] as any).parsed.info
        const outInfo: SPLTransferInfo = (splTransferPair[1] as any).parsed.info
        const userShitAcc = getAssociatedTokenAddressSync(tokenMint, new PublicKey(inInfo.authority), true)
        const isSelling = inInfo.source === userShitAcc.toString()


        const shitAmount = Number(isSelling ? inInfo.amount : outInfo.amount) / (10 ** tokenDecimals)
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
  } catch (e) {
    console.log(`Failed to parse history ${e}`)
  }

  return results
}