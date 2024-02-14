import { TradeRecord } from "./TradesFetcher";

export function findDumpingRecord(data: TradeRecord[], threshold: number = 50): [TradeRecord, TradeRecord] | null {
  for (let i = data.length - 1; i > 1; i--) {
    const current = data[i];
    const next = data[i - 1];
    if (!(current.type === 'SELL' && next.type === 'BUY')) { continue }
    const percentageChange = ((next.priceInSOL - current.priceInSOL) / current.priceInSOL) * 100;

    if (percentageChange <= -threshold) return [current, next]; // Dump detected
  }
  return null; // No dump detected
}

export type ChartTrend = 'GROWING' | 'DIPPING'
export function determineTrend(data: TradeRecord[]): ChartTrend {
  const recentData = data.slice(-14); // Last 14 data points, adjust as needed
  const total = recentData.reduce((acc, val) => acc + val.priceInSOL, 0);
  const average = total / recentData.length;

  const trend: ChartTrend = recentData[recentData.length - 1].priceInSOL > average ? 'GROWING' : 'DIPPING';
  return trend; // This is a very simplified way to determine the trend
}

