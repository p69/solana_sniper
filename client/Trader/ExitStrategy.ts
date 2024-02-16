export interface ExitStrategy {
  exitTimeoutInMillis: number,
  targetProfit: number,
}

export const SAFE_EXIT_STRATEGY: ExitStrategy = {
  exitTimeoutInMillis: 24 * 60 * 60 * 1000, // wait for 24 hours
  targetProfit: 4.9, // 500% (10% for slippage) to target, we must be early to 
}

export const DANGEROUS_EXIT_STRATEGY: ExitStrategy = {
  exitTimeoutInMillis: 1 * 60 * 1000, // 1 minutes time when token looks good
  targetProfit: 0.19, // make 9% (10% for slippage) in more secure way. owner could dump all tokens
}

export const RED_TEST_EXIT_STRATEGY: ExitStrategy = {
  exitTimeoutInMillis: 1000, // 1 second time when token looks good
  targetProfit: 0.01, // make 9% (10% for slippage) in more secure way. owner could dump all tokens
}