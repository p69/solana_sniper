import { PublicKey, ParsedTransactionWithMeta, Connection, ParsedAccountData } from '@solana/web3.js'
import { getAssociatedTokenAddressSync } from "@solana/spl-token"
import { WSOL } from '@raydium-io/raydium-sdk'
import { PoolKeys } from '../PoolValidator/RaydiumPoolParser'


export type TradeType = 'BUY' | 'SELL'

export interface TradeRecord {
  signature: string
  time: string
  epochTime: number
  type: TradeType
  tokenAmount: number
  solAmount: number
  usdAmount: number
  priceInSOL: number
  priceInUSD: number
}

interface SPLTransferInfo {
  amount: string
  authority: string
  destination: string
  source: string
}

export async function fetchLatestTrades(
  connection: Connection,
  poolKeys: PoolKeys,
  tradingPoolAddress: PublicKey,
  tokenMint: PublicKey,
  tokenDecimals: number): Promise<TradeRecord[]> {
  const txs = await fetchAllTransactions(connection, tradingPoolAddress)
  const tradeRecords = await parseTradingData(connection, poolKeys, txs, tokenMint, tokenDecimals)
  return tradeRecords
}

async function fetchAllTransactions(connection: Connection, address: PublicKey): Promise<ParsedTransactionWithMeta[]> {
  let results: ParsedTransactionWithMeta[] = []
  let hasMore = true
  const limit = 1000
  let beforeTx: string | undefined = undefined
  while (hasMore) {
    const fetchedIds = await connection.getConfirmedSignaturesForAddress2(address, { limit: limit, before: beforeTx })
    if (fetchedIds.length === 0) { break }
    const filtered = fetchedIds.filter(x => !x.err)
    const tradesOrNull = await connection.getParsedTransactions(filtered.map(x => x.signature), { maxSupportedTransactionVersion: 0 })
    const trades: ParsedTransactionWithMeta[] = tradesOrNull.filter((transaction): transaction is ParsedTransactionWithMeta => transaction !== null);
    results.push(...trades)
    hasMore = fetchedIds.length === limit
    beforeTx = fetchedIds[fetchedIds.length - 1].signature
  }
  return results
}

async function parseTradingData(
  connection: Connection,
  poolKeys: PoolKeys,
  transactions: (ParsedTransactionWithMeta | null)[],
  tokenMint: PublicKey,
  tokenDecimals: number): Promise<TradeRecord[]> {
  let results: TradeRecord[] = []

  for (let txOrNull of transactions) {
    if (!txOrNull) { continue }

    const inner = txOrNull.meta?.innerInstructions
    if (!inner) { continue }

    const splTransferPairs = inner.map(x => x.instructions.filter((a: any) => a.program === 'spl-token'))
    const splTransferPair = splTransferPairs.find(x => x.length === 2)
    const preBalances = txOrNull.meta?.preTokenBalances
    const postBalances = txOrNull.meta?.postTokenBalances
    if (splTransferPair) {
      // const userOtherTokenPreBalance = preBalances.reduce((sum, x) => {
      //   if (x.owner !== raydiumPoolAuthority && x.mint === shitToken) {
      //     return sum += x.uiTokenAmount.uiAmount ?? 0
      //   }
      //   return sum
      // }, 0)

      // const userOtherTokenPostBalance = postBalances.reduce((sum, x) => {
      //   if (x.owner !== raydiumPoolAuthority && x.mint === shitToken) {
      //     return sum += x.uiTokenAmount.uiAmount ?? 0
      //   }
      //   return sum
      // }, 0)

      // const userSolPreBalance = preBalances.reduce((sum, x) => {
      //   if (x.owner !== raydiumPoolAuthority && x.mint === WSOL.mint) {
      //     return sum += x.uiTokenAmount.uiAmount ?? 0
      //   }
      //   return sum
      // }, 0)

      // const userSolPostBalance = postBalances.reduce((sum, x) => {
      //   if (x.owner !== raydiumPoolAuthority && x.mint === WSOL.mint) {
      //     return sum += x.uiTokenAmount.uiAmount ?? 0
      //   }
      //   return sum
      // }, 0)

      const inInfo: SPLTransferInfo = (splTransferPair[0] as any).parsed.info
      const outInfo: SPLTransferInfo = (splTransferPair[1] as any).parsed.info

      // TODO: improve

      const quoteIsToken = poolKeys.quoteMint === tokenMint.toString()

      const isSelling = quoteIsToken ? inInfo.destination === poolKeys.quoteVault : inInfo.destination === poolKeys.baseVault  //userOtherTokenPostBalance < userOtherTokenPreBalance
      const txDate = new Date(0)
      txDate.setUTCSeconds(txOrNull.blockTime ?? 0)

      const shitAmount = Number(isSelling ? inInfo.amount : outInfo.amount) / (10 ** tokenDecimals) //Math.abs(userOtherTokenPostBalance - userOtherTokenPreBalance)
      const solAmount = Number(isSelling ? outInfo.amount : inInfo.amount) / (10 ** WSOL.decimals) //Math.abs(userSolPostBalance - userSolPreBalance)
      const priceInSOL = solAmount / shitAmount
      results.push({
        signature: txOrNull.transaction.signatures[0],
        time: formatTime(txDate),
        epochTime: txOrNull.blockTime ?? 0,
        type: isSelling ? 'SELL' : 'BUY',
        tokenAmount: shitAmount,
        solAmount,
        usdAmount: solAmount * 110,
        priceInSOL: priceInSOL,
        priceInUSD: priceInSOL * 110
      })
    }
  }

  return results
}

function isParsedAccountData(data: Buffer | ParsedAccountData): data is ParsedAccountData {
  return (data as ParsedAccountData).parsed !== undefined;
}

function formatTime(date: Date): string {
  // Get hours, minutes, and seconds from the date
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  const seconds = String(date.getSeconds()).padStart(2, '0');

  // Format time as 'HH:MM:SS'
  return `${hours}:${minutes}:${seconds}`;
}