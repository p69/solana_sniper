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