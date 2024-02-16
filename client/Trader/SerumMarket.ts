import * as dotenv from 'dotenv'
dotenv.config()
import { PublicKey, ParsedTransactionWithMeta, ConfirmedSignatureInfo, TokenAmount, AccountInfo, ParsedAccountData } from '@solana/web3.js'
import { TOKEN_PROGRAM_ID, getAssociatedTokenAddress, getAssociatedTokenAddressSync, getOrCreateAssociatedTokenAccount } from '@solana/spl-token'
import { connection } from './Connection'
import { Token, WSOL, Spl } from '@raydium-io/raydium-sdk';
import fs from 'fs'
import path, { resolve } from 'path'
import csv from 'csv-parser'
import { TradeRecord, TradeType } from './TradesFetcher'
import { ChartTrend, analyzeTrend } from './TradesAnalyzer'

const raydiumPoolAuthority = "5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1"

const eventQueue = "GsKj8Mmiu6k8FCjY31jgZY9y3xEjwXgiuD42DFTgCHkf"
const openOrders = "8BKdZAafGGbxaKKLe7GvFCNFha9XJan1ZbZBT7EiwcLh"
const rPoolAcc = "5CrZMaLVzDaZiinmPYM9ntAAqsmAvH4JKAKDczYRbXdd"
//const shitToken = "CUuJRwXVmne5Gqz62ao2GsyZY9rUVPy487Z9bqSCTL4c"
const poolTokenAccount = new PublicKey('BoiDCWjwLCzyKHcM4ZXEgviHjs5UphiPKMLegFeEfG1T') //getAssociatedTokenAddressSync(new PublicKey(shitToken), new PublicKey(rPoolAcc))
const poolSolAccount = getAssociatedTokenAddressSync(new PublicKey(WSOL.mint), new PublicKey('5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1'), true)
const shitTokenDecimals = new Map<string, number>([
  ['AhTTDdWqwMJu3h8e6ugxbQTcjw1m8t3oSq9zq2FfEFoW', 6],
  ['8zWopWi9jaDH4AKVf3QRMcPs5BSDth3GWJu6DcbfeVJT', 6],
  ['7prAFNmy6FsgjaRXyVJQH9B3rMfGjG497MdRn52Ee3Yb', 6],
  ['5iPa8J5K8yA9KdcjZ1QPVYMEreGpMu9qvQQRtRVzDLt2', 9],
  ['CTnTtkfLSGVoV5uMfM9DzuxaytExFgrW5krGGztYymAP', 9],
  ['3zA4wvbCm85dqan1RtX2g7pR6typ4DVQZchPrrp3PTTJ', 9],
])

const poolsToGetPriceChanges = [
  'ASUUfLjhtacBbjx7KswSraRYvZMUdbWsjMNjDYngzaex',
  'DoNtsgPxYZfpq5cpBFH1PqAwhJDU9G7RCG1EPgCUiwRx',
  'A3isw2Xco9TtpvKgm9j7UcjUoGpCP4FfhrnXPGnxgKrQ',
  'Es6nqcHuFvj8VNJ1obfwkoD6zAgwvdY2WCa4EGsPrfZU',
  'AqaXfDnGCzTK14U69QjWWThDCEBD5iiwvpM5dMCxeWBj',
  '3ZMzLJMozbPKex7jyhsQUwDYxecJNWutdKEhoDsBmRjk'
]

async function test() {
  //const poolsWithRecords = await Promise.all(poolsToGetPriceChanges.map(x => getTradeRecords(x)))
  const first = await getTradeRecords(poolsToGetPriceChanges[0], 'AhTTDdWqwMJu3h8e6ugxbQTcjw1m8t3oSq9zq2FfEFoW')
  const second = await getTradeRecords(poolsToGetPriceChanges[1], '8zWopWi9jaDH4AKVf3QRMcPs5BSDth3GWJu6DcbfeVJT')
  const third = await getTradeRecords(poolsToGetPriceChanges[2], '7prAFNmy6FsgjaRXyVJQH9B3rMfGjG497MdRn52Ee3Yb')
  const fourth = await getTradeRecords(poolsToGetPriceChanges[3], '5iPa8J5K8yA9KdcjZ1QPVYMEreGpMu9qvQQRtRVzDLt2')
  const fifth = await getTradeRecords(poolsToGetPriceChanges[4], 'CTnTtkfLSGVoV5uMfM9DzuxaytExFgrW5krGGztYymAP')
  const sixth = await getTradeRecords(poolsToGetPriceChanges[5], '3zA4wvbCm85dqan1RtX2g7pR6typ4DVQZchPrrp3PTTJ')
  for (let { poolId, trades } of [first, second, third, fourth, fifth, sixth]) {
    saveToCSV(poolId, trades.sort((a, b) => a.epochTime - b.epochTime))
  }
}

async function loadSaved() {
  for (let poolId of poolsToGetPriceChanges) {
    const records = await parseCSV(poolId)
    const firstEpochTime = records[0].epochTime
    const lastEpochTime = firstEpochTime + 60
    const filteredRecords = records.filter(x => x.epochTime <= lastEpochTime && x.type === 'BUY' && x.priceInSOL <= 2)
    const trend = analyzeTrend(records.filter(x => x.epochTime <= lastEpochTime && x.type === 'BUY' && x.priceInSOL <= 2))
    console.log(`${poolId} - ${trendToColor(trend.trend, filteredRecords.length)}, rate=${trend.averageGrowthRate}, valotily=${trend.isVolatile}`)
  }
}

function trendToColor(trend: ChartTrend, buysCount: number): string {
  switch (trend) {
    case 'EQUILIBRIUM': return buysCount >= 40 ? '🟢 Good' : '🔴 Bad' //'🟡 So So'
    case 'PUMPING': return '🟢 Good'
    case 'DUMPING': return '🔴 Bad'
    default: return '⚪ Unknown'
  }
}

loadSaved()
// test()

function calcBuyVolumeForTheFirstMinute(records: TradeRecord[]): { sumInUSD: number, sumInSOL: number, totalTrades: number } {
  const startTime = records[0].epochTime
  const endTime = startTime + 60
  return records.reduce((sum, r) => {
    if (r.epochTime < endTime && r.type === 'BUY') {
      return { sumInUSD: sum.sumInUSD + r.usdAmount, sumInSOL: sum.sumInSOL + r.solAmount, totalTrades: sum.totalTrades + 1 }
    }
    return sum
  }, { sumInUSD: 0, sumInSOL: 0, totalTrades: 0 })
}

async function parseCSV(poolId: string): Promise<TradeRecord[]> {
  return new Promise((resolve, _) => {
    const filePath = path.join(__dirname, `/trading_data/${poolId}.csv`)
    const records: TradeRecord[] = []

    const mapValues = (args: { header: string, index: number, value: any }) => {
      if (args.index <= 1) {
        return args.value
      }
      if (args.index === 3) {
        return args.value as TradeType
      }
      return Number(args.value)
    }

    const csvOptions = {
      headers: ['signature', 'time', 'epochTime', 'type', 'tokenAmount', 'solAmount', 'usdAmount', 'priceInSOL', 'priceInUSD'],
      mapValues: mapValues,
      skipLines: 1
    }
    fs.createReadStream(filePath)
      .pipe(csv(csvOptions))
      .on("data", function (row: TradeRecord) {
        records.push(row)
      })
      .on('end', () => {
        records.sort((a, b) => a.epochTime - b.epochTime)
        resolve(records)
      })
  })
}

async function getTradeRecords(poolId: string, tokenMint: string): Promise<{ poolId: string, trades: TradeRecord[] }> {
  //const count = Array.from({ length: 10 }, (_, i) => i)
  //const allTransactions = await Promise.all(count.map(x => connection.getConfirmedSignaturesForAddress2(new PublicKey(poolId), { limit: 1000 })))
  const trades = await fetchAllTransactions(new PublicKey(poolId))
  const tradeRecords = await parseTradingData(trades, tokenMint)
  return { poolId, trades: tradeRecords }
}

async function fetchAllTransactions(address: PublicKey): Promise<ParsedTransactionWithMeta[]> {
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

function saveToCSV(fileName: string, data: TradeRecord[]) {
  const titleKeys = Object.keys(data[0])
  const refinedData = []
  refinedData.push(titleKeys)
  data.forEach(item => {
    refinedData.push(Object.values(item))
  })

  let csvContent = ''

  const filePath = path.join(__dirname, `/trading_data/${fileName}.csv`)

  refinedData.forEach(row => {
    csvContent += row.join(',') + '\n'
  })
  fs.writeFileSync(filePath, csvContent, {})
}

async function parseTradingData(transactions: ParsedTransactionWithMeta[], shitToken: string): Promise<TradeRecord[]> {
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

      const destinationAccInfo = (await connection.getParsedAccountInfo(new PublicKey(inInfo.destination))).value
      if (!destinationAccInfo) {
        continue
      }
      if (!isParsedAccountData(destinationAccInfo.data)) {
        continue
      }
      const destinationTokenMint = destinationAccInfo.data.parsed.info.mint
      const isSelling = destinationTokenMint === shitToken  //userOtherTokenPostBalance < userOtherTokenPreBalance
      const txDate = new Date(0)
      txDate.setUTCSeconds(txOrNull.blockTime ?? 0)

      const decimals = shitTokenDecimals.get(shitToken)!
      const shitAmount = Number(isSelling ? inInfo.amount : outInfo.amount) / (10 ** decimals) //Math.abs(userOtherTokenPostBalance - userOtherTokenPreBalance)
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

interface SPLTransferInfo {
  amount: string
  authority: string
  destination: string
  source: string
}