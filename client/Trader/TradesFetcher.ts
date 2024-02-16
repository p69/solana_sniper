import { PublicKey, ParsedTransactionWithMeta, Connection, ParsedAccountData } from '@solana/web3.js'
import { getAssociatedTokenAddressSync } from "@solana/spl-token"
import { WSOL } from '@raydium-io/raydium-sdk'


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
  tradingPoolAddress: PublicKey,
  tokenMint: PublicKey,
  tokenDecimals: number,
  limit: number = 1000): Promise<TradeRecord[]> {
  const allTransactions = await connection.getConfirmedSignaturesForAddress2(tradingPoolAddress, { limit: limit })
  const filtered = allTransactions.filter(x => !x.err)
  const trades = await connection.getParsedTransactions(filtered.map(x => x.signature), { maxSupportedTransactionVersion: 0 })
  return await parseTradingData(connection, trades, tokenMint, tokenDecimals)
}

async function parseTradingData(
  connection: Connection,
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
      const destinationAccInfo = (await connection.getParsedAccountInfo(new PublicKey(inInfo.destination))).value
      if (!destinationAccInfo) {
        continue
      }
      if (!isParsedAccountData(destinationAccInfo.data)) {
        continue
      }
      const destinationTokenMint = destinationAccInfo.data.parsed.info.mint
      const isSelling = destinationTokenMint === tokenMint.toString()  //userOtherTokenPostBalance < userOtherTokenPreBalance
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