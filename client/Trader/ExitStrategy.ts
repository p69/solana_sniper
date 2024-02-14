export interface ExitStrategy {
  exitTimeoutInMillis: number,
  targetProfit: number,
}

export const SAFE_EXIT_STRATEGY: ExitStrategy = {
  exitTimeoutInMillis: 30 * 60 * 1000, // 10 minutes time when token looks good
  targetProfit: 4.9, // 500% (10% for slippage) to target, we must be early to 
}

export const DANGEROUS_EXIT_STRATEGY: ExitStrategy = {
  exitTimeoutInMillis: 1 * 60 * 1000, // 1 minutes time when token looks good
  targetProfit: 0.09, // make 9% (10% for slippage) in more secure way. owner could dump all tokens
}