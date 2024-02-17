import { TradeRecord } from "./TradesFetcher";

export function findDumpingRecord(data: TradeRecord[], threshold: number = 50): [TradeRecord, TradeRecord] | null {
  for (let i = data.length - 1; i > 1; i--) {
    const next = data[i]
    const current = data[i - 1]
    if (current.type !== 'SELL') { continue }
    const percentageChange = ((next.priceInSOL - current.priceInSOL) / current.priceInSOL) * 100;

    if (percentageChange <= -threshold) return [current, next]; // Dump detected
  }
  return null; // No dump detected
}

export type ChartTrend = 'EQUILIBRIUM' | 'PUMPING' | 'DUMPING'
export type TrendAnalisis = {
  type: ChartTrend,
  averageGrowthRate: number,
  volatility: number,
  buysCount: number
}

export function standardDeviation(values: number[]): number {
  const avg = values.reduce((sum, value) => sum + value, 0) / values.length;
  const squareDiffs = values.map(value => (value - avg) ** 2);
  const avgSquareDiff = squareDiffs.reduce((sum, value) => sum + value, 0) / squareDiffs.length;
  return Math.sqrt(avgSquareDiff);
}

const FAST_PRICE_CHANGING_RATE = 0.001

export function analyzeTrend(data: TradeRecord[]): TrendAnalisis {
  const lastEpochTime = data[0].epochTime + 60 // Check only first minute
  const tooLargeBet = 2
  const filtered = data.filter(x => x.epochTime <= lastEpochTime && x.type === 'BUY' && x.priceInSOL <= tooLargeBet)
  let growthRates: number[] = []
  // Calculate growth rates between each pair of records
  for (let i = 1; i < filtered.length; i++) {
    const prevPrice = filtered[i - 1].priceInSOL;
    const currentPrice = filtered[i].priceInSOL;
    const growthRate = (currentPrice - prevPrice) / prevPrice;
    growthRates.push(growthRate);
  }

  // Calculate average growth rate
  const averageGrowthRate = growthRates.reduce((acc, rate) => acc + rate, 0) / growthRates.length;

  // Calculate volatility (standard deviation of growth rates)
  const volatility = standardDeviation(growthRates);

  // Determine trend based on average growth rate and volatility

  let trend: ChartTrend = 'EQUILIBRIUM'
  if (averageGrowthRate >= FAST_PRICE_CHANGING_RATE) {
    trend = 'PUMPING'
  } else if (averageGrowthRate <= -FAST_PRICE_CHANGING_RATE) {
    trend = 'DUMPING'
  }

  return { type: trend, averageGrowthRate, volatility, buysCount: filtered.length };
}