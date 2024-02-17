export interface ExitStrategy {
  exitTimeoutInMillis: number,
  targetProfit: number,
  profitCalcIterationDelayMillis: number,
}

export const SAFE_EXIT_STRATEGY: ExitStrategy = {
  exitTimeoutInMillis: 30 * 60 * 1000, // wait for 30 minutes
  targetProfit: 0.29, // 30% (1% for slippage) to target
  profitCalcIterationDelayMillis: 500 // 0.5 seconds
}

export const DANGEROUS_EXIT_STRATEGY: ExitStrategy = {
  exitTimeoutInMillis: 1 * 60 * 1000, // 1 minutes time when token looks good
  targetProfit: 0.19, // make 20% (1% for slippage) in more secure way. owner could dump all tokens
  profitCalcIterationDelayMillis: 500 // 0.5 seconds
}

export const RED_TEST_EXIT_STRATEGY: ExitStrategy = {
  exitTimeoutInMillis: 1000, // 1 second time when token looks good
  targetProfit: 0.01, // make 9% (10% for slippage) in more secure way. owner could dump all tokens
  profitCalcIterationDelayMillis: 500 // 0.5 seconds
}