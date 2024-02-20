import { Connection, PublicKey } from '@solana/web3.js';
import { findLogEntry } from './PoolValidator/RaydiumPoolParser';
import chalk from 'chalk';
import { ValidatePoolData, validateNewPool } from './PoolValidator/RaydiumPoolValidator';
import { PoolValidationResults } from './PoolValidator/ValidationResult';
import { delay, formatDate } from './Utils';
import { config } from './Config';
import { SellResults } from './Trader/SellToken';
import { SOL_SPL_TOKEN_ADDRESS } from './Trader/Addresses';
import { tryPerformTrading } from './Trader/Trader';

const RAYDIUM_PUBLIC_KEY = '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8';

interface ReadyToTrade {
  kind: 'OK'
}

interface NotReadyToTrade {
  kind: 'BAD',
  reason: string
}

type TradingDecision = ReadyToTrade | NotReadyToTrade

export class TradingBot {
  private onLogsSubscriptionId: number | null = null
  private connection: Connection
  private tradingWallet: { startValue: number, current: number, totalProfit: number } = {
    startValue: 1,
    current: 1,
    totalProfit: 0
  }
  private seenTransactions = new Set();
  private runningTradesCount = 0
  private maxCountOfSimulteniousTradings = 0
  private runningValidatorsCount = 0
  private maxCountOfSimulteniousValidators = 0
  private skippedPools: string[] = []
  private allValidatedPools = new Map<string, string>()
  private completedTrades: string[] = []
  private validationErrors: string[] = []
  private runningValidations = new Map<string, string>()


  // private validatorPool = new Piscina({
  //   filename: path.resolve(__dirname, './PoolValidator/RaydiumPoolValidator.js'),
  //   maxQueue: 'auto',
  //   maxThreads: 10,
  // });

  // private traderPool = new Piscina({
  //   filename: path.resolve(__dirname, './Trader/Trader.js'),
  //   maxQueue: 'auto',
  // })

  constructor(connection: Connection) {
    this.connection = connection
  }

  isStarted() {
    return this.onLogsSubscriptionId !== null
  }

  private updateWSOLBalance(tradeResults: SellResults) {
    if (tradeResults.boughtForSol) {
      const soldForSol = tradeResults.kind === 'SUCCESS' ? tradeResults.soldForSOL : 0
      const profitAbsolute = soldForSol - tradeResults.boughtForSol
      const newWalletBalance = this.tradingWallet.current + profitAbsolute
      const totalProfit = (newWalletBalance - this.tradingWallet.startValue) / this.tradingWallet.startValue
      this.tradingWallet = { ...this.tradingWallet, current: newWalletBalance, totalProfit }

      console.log(`Wallet:\n${JSON.stringify(this.tradingWallet, null, 2)}`)
    }
  }

  private async fetchInitialWalletSOLBalance() {
    if (config.simulateOnly) { return }
    const balance = ((await this.connection.getTokenAccountBalance(SOL_SPL_TOKEN_ADDRESS)).value.uiAmount ?? 0)
    this.tradingWallet.current = balance
    this.tradingWallet.startValue = balance
  }

  async start() {
    console.log(`Start Solana bot. Simulation=${config.simulateOnly}`)

    await this.fetchInitialWalletSOLBalance()

    console.log(`Wallet:\n${JSON.stringify(this.tradingWallet, null, 2)}`)

    const raydium = new PublicKey(RAYDIUM_PUBLIC_KEY);

    this.onLogsSubscriptionId = this.connection.onLogs(raydium, async (txLogs) => {
      if (this.seenTransactions.has(txLogs.signature)) {
        return;
      }
      this.seenTransactions.add(txLogs.signature);
      if (!findLogEntry('init_pc_amount', txLogs.logs)) {
        return; // If "init_pc_amount" is not in log entries then it's not LP initialization transaction
      }

      this.handleNewPoolMintTx(txLogs.signature)
    });
    console.log(chalk.cyan('Listening to new pools...'))
  }

  stop() {
    if (this.onLogsSubscriptionId) {
      this.connection.removeOnLogsListener(this.onLogsSubscriptionId)
    }
  }

  getSkippedPools() {
    return this.skippedPools
  }

  getTradingResults() {
    return this.completedTrades
  }

  getWalletTradingInfo() {
    return this.tradingWallet
  }

  getRunningValidationInfo() {
    return this.runningValidations
  }

  getCompletedValidations() {
    return this.allValidatedPools
  }

  getValidationErrors() {
    return this.validationErrors
  }

  private onError(error: Error) {
    console.error(error)
  }

  private onTradingResults(poolId: string, tradeResults: SellResults) {
    this.completedTrades.push(`Pool: ${poolId}, Trading resulst: ${JSON.stringify(tradeResults)}`)
    if (this.onLogsSubscriptionId === null) { return }
    this.runningTradesCount--
    console.log(`Running Traders - current: ${this.runningTradesCount}, max: ${this.maxCountOfSimulteniousTradings} `)
    console.log(`Pool ${poolId}, trading results: ${JSON.stringify(tradeResults)} `)

    this.updateWSOLBalance(tradeResults)
    console.log(chalk.yellow('Got trading results'))
  }

  private async startTrading(validationResults: PoolValidationResults) {
    console.log(`Start trading for pool ${validationResults.pool.id}`)
    this.runningTradesCount++
    if (this.maxCountOfSimulteniousTradings < this.runningTradesCount) {
      this.maxCountOfSimulteniousTradings = this.runningTradesCount
    }
    console.log(`Running Traders - current: ${this.runningTradesCount}, max: ${this.maxCountOfSimulteniousTradings} `)
    tryPerformTrading(this.connection, validationResults)
      .then(x => this.onTradingResults(validationResults.pool.id, x))
      .catch(this.onError)
  }

  private evaluateTradingDecision(validationResults: PoolValidationResults): TradingDecision {
    if (validationResults.safetyStatus === 'RED') {
      const msg = `Pool: ${validationResults.pool.id}, RED token.\n${JSON.stringify(validationResults)}`
      return { kind: 'BAD', reason: msg }
    }

    if (validationResults.safetyStatus !== 'GREEN') {
      if (validationResults.trend!.volatility > config.safePriceValotilityRate) {
        const msg = `Pool: ${validationResults.pool.id}, Not GREEN token and Price volatility is to high ${validationResults.trend!.volatility}`
        return { kind: 'BAD', reason: msg }
      }

      if (validationResults.trend!.buysCount < config.safeBuysCountInFirstMinute) {
        const msg = `Pool: ${validationResults.pool.id}, Not GREEN token and Very little BUY txs ${validationResults.trend!.buysCount}`
        return { kind: 'BAD', reason: msg }
      }
    }

    return { kind: 'OK' }
  }

  private async onPoolValidationResults(txId: string, validationResults: PoolValidationResults | string) {
    this.runningValidatorsCount--
    if (this.onLogsSubscriptionId === null) { return }

    this.runningValidations.set(txId, `Initial validation results: ${JSON.stringify(validationResults)}`)

    // When error happened
    if (typeof validationResults === `string`) {
      console.log(`Failed to validate pool by first min tx https://solscan.io/tx/${txId}\nValidaition Error: ${validationResults}`)
      this.skippedPools.push(`Failed to validate pool by first min tx https://solscan.io/tx/${txId}\nValidaition Error: ${validationResults}`)
      this.runningValidations.delete(txId)
      this.validationErrors.push(`MintTx: ${txId}, error: ${validationResults}`)
      // Notify state listener onPoolValidationFailed
      return
    }

    console.log(chalk.yellow(`Validation results for pool ${validationResults.pool.id}`))
    // If pool is postponed
    if (validationResults.startTimeInEpoch) {
      console.log(`Pool ${validationResults.pool.id} is postponed to ${formatDate(new Date(validationResults.startTimeInEpoch))}`)
      this.runningValidations.set(txId, `Pool is postponed to ${formatDate(new Date(validationResults.startTimeInEpoch))} wait for it. ${JSON.stringify(validationResults)}`)
      const delayBeforeStart = (validationResults.startTimeInEpoch * 1000) - Date.now()
      const maxTimeToWait = 24 * 60 * 60 * 1000
      if (delayBeforeStart > 0 && delayBeforeStart < maxTimeToWait) {
        console.log(`Wait until it starts`)
        await delay(delayBeforeStart + 300)
        if (this.onLogsSubscriptionId === null) { return }
        console.log(`Running Validators - current: ${this.runningValidatorsCount}, max: ${this.maxCountOfSimulteniousValidators}`)
        this.runningValidations.set(txId, `Postponed pool has started, performing another validation. ${JSON.stringify(validationResults)}`)
        validationResults = await validateNewPool(this.connection, txId)
        this.runningValidations.set(txId, `Received updated results for postponed pool. ${JSON.stringify(validationResults)}`)
        if (this.onLogsSubscriptionId === null) { return }
        console.log(`Got updated results`)
      } else {
        this.skippedPools.push(`Pool ${validationResults.pool.id} Skipped because it's postponed for too long.`)
        this.runningValidations.delete(txId)
        this.runningValidatorsCount--
        console.log(`It's too long, don't wait. Need to add more robust scheduler`)
        return
      }
    }

    this.runningValidations.delete(txId)
    this.runningValidatorsCount--

    if (typeof validationResults === `string`) {
      console.log(`Failed to validate postponed Pool TxId ${txId} with error: ${validationResults}`)
      this.skippedPools.push(`Failed to validate postponed Pool TxId ${txId} with error: ${validationResults}`)
      this.validationErrors.push(`MintTx: ${txId}, error: ${validationResults}`)
      // Notify state listener onPoolValidationFailed
      return
    }

    this.allValidatedPools.set(validationResults.pool.id, JSON.stringify(validationResults.safetyStatus))

    // Notify state listener onPoolValidationCompleted
    console.log(`Token in pool ${validationResults.pool.id} is ${validationResults.safetyStatus}`)
    console.log(`Pool ${validationResults.pool.id} validation results reason is ${validationResults.reason}`)
    console.log(`Pool ${validationResults.pool.id} trend is ${JSON.stringify(validationResults.trend)}`)

    const tradingDecision = this.evaluateTradingDecision(validationResults)
    console.log(`Pool: ${validationResults.pool.id} trading decision: ${tradingDecision.kind}`)
    switch (tradingDecision.kind) {
      case 'BAD': {
        console.log(`Pool: ${validationResults.pool.id} Ignore BAD token trading. ${tradingDecision.reason}`)
        this.skippedPools.push(tradingDecision.kind)
        break
      }
      case 'OK': {
        console.log(`Pool: ${validationResults.pool.id} Try OK token trading.`)
        this.startTrading(validationResults)
        break
      }
    }
  }

  private async handleNewPoolMintTx(txId: string) {
    if (this.onLogsSubscriptionId === null) { return }

    if (this.runningValidatorsCount === config.validatorsLimit) {
      console.log(chalk.yellow(`Find pool with tx - ${txId} but limit of ${config.validatorsLimit} has been reached. Skipped`))
      this.skippedPools.push(`Find pool with tx - ${txId} but limit of ${config.validatorsLimit} has been reached. Skipped`)
      return
    }
    console.log(chalk.yellow(`Received first mint tx https://solscan.io/tx/${txId}. Start processing.`))

    this.runningValidatorsCount++
    if (this.runningValidatorsCount > this.maxCountOfSimulteniousValidators) {
      this.maxCountOfSimulteniousValidators = this.runningValidatorsCount
    }
    console.log(`Running Validators - current: ${this.runningValidatorsCount}, max: ${this.maxCountOfSimulteniousValidators}`)

    this.runningValidations.set(txId, `Running iniitial validation.`)

    validateNewPool(this.connection, txId)
      .then(res => this.onPoolValidationResults(txId, res))
      .catch(this.onError)
  }
}