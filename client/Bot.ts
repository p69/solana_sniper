import * as fs from 'fs'
import * as util from 'util'
import { Connection, PublicKey } from '@solana/web3.js';
import path from 'path';
import Piscina from 'piscina';
import { findLogEntry } from './PoolValidator/RaydiumPoolParser';
import chalk from 'chalk';
import { ValidatePoolData } from './PoolValidator/RaydiumPoolValidator';
import { PoolValidationResults } from './PoolValidator/ValidationResult';
import { delay, formatDate, printTime } from './Utils';
import { config } from './Config';
import { SellResults } from './Trader/SellToken';
import { SOL_SPL_TOKEN_ADDRESS } from './Trader/Addresses';

// Specify the log file path
const log_fil_sufix = (new Date()).getUTCSeconds()
const logFilePath = path.join(__dirname, `/logs/application_${log_fil_sufix}.log`)


// Create a write stream for the log file
const logFileStream = fs.createWriteStream(logFilePath, { flags: 'a' }); // 'a' flag for append mode

// Original console.log function
const originalConsoleLog = console.log;

// Override console.log
console.log = (...args: any[]) => {
  // Format the message as console.log would
  const message = util.format.apply(null, args) + '\n';

  // Write to the original console.log
  originalConsoleLog.apply(console, args);

  // Write the formatted message to the log file
  logFileStream.write(message);
};

const RAYDIUM_PUBLIC_KEY = '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8';

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


  private validatorPool = new Piscina({
    filename: path.resolve(__dirname, './PoolValidator/RaydiumPoolValidator.js'),
    maxQueue: 'auto',
    maxThreads: 10,
  });

  private traderPool = new Piscina({
    filename: path.resolve(__dirname, './Trader/Trader.js'),
    maxQueue: 'auto',
  })

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

      await this.handleNewPoolMintTx(txLogs.signature)
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

  private async handleNewPoolMintTx(txId: string) {
    if (this.onLogsSubscriptionId === null) { return }

    if (this.runningValidatorsCount === config.validatorsLimit) {
      console.log(chalk.yellow(`Find pool with tx - ${txId} but limit of ${config.validatorsLimit} has been reached. Skipped`))
      this.skippedPools.push(`Find pool with tx - ${txId} but limit of ${config.validatorsLimit} has been reached. Skipped`)
      return
    }
    console.log(chalk.yellow(`Received first mint tx https://solscan.io/tx/${txId}. Start processing.`))
    const msg: ValidatePoolData = {
      mintTxId: txId,
      date: new Date()
    }

    this.runningValidatorsCount++
    if (this.runningValidatorsCount > this.maxCountOfSimulteniousValidators) {
      this.maxCountOfSimulteniousValidators = this.runningValidatorsCount
    }
    console.log(`Running Validators - current: ${this.runningValidatorsCount}, max: ${this.maxCountOfSimulteniousValidators}`)

    this.runningValidations.set(txId, `Running iniitial validation.`)

    let validationResults: PoolValidationResults | string = await this.validatorPool.run(msg)
    if (this.onLogsSubscriptionId === null) { return }
    this.runningValidatorsCount--

    this.runningValidations.set(txId, `Initial validation results: ${JSON.stringify(validationResults)}`)

    if (typeof validationResults === `string`) {
      console.log(`Failed to validate pool by first min tx https://solscan.io/tx/${txId}\nValidaition Error: ${validationResults}`)
      this.skippedPools.push(`Failed to validate pool by first min tx https://solscan.io/tx/${txId}\nValidaition Error: ${validationResults}`)
      this.runningValidations.delete(txId)
      this.validationErrors.push(`MintTx: ${txId}, error: ${validationResults}`)
      // Notify state listener onPoolValidationFailed
      return
    }

    console.log(chalk.yellow(`Validation results for pool ${validationResults.pool.id}`))
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
        validationResults = await this.validatorPool.run(msg)
        this.runningValidations.set(txId, `Received updated results for postponed pool. ${JSON.stringify(validationResults)}`)
        if (this.onLogsSubscriptionId === null) { return }
        console.log(`Got updated results`)
      } else {
        console.log(`It's too long, don't wait. Need to add more robust scheduler`)
      }
    }

    this.runningValidations.delete(txId)

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

    if (validationResults.safetyStatus === 'RED') {
      console.log(chalk.red('Red token. Skipping'))
      this.skippedPools.push(`Pool: ${validationResults.pool.id}, mintTx: ${txId} RED token.\n${JSON.stringify(validationResults)}`)
      return
    }

    if (validationResults.safetyStatus !== 'GREEN') {
      if (validationResults.trend!.volatility > config.safePriceValotilityRate) {
        const msg = `Pool: ${validationResults.pool.id}, mintTx: ${txId}.\nNot GREEN token and Price volatility is to high ${validationResults.trend!.volatility}`
        console.log(msg)
        this.skippedPools.push(msg)
        return
      }

      if (validationResults.trend!.buysCount < config.safeBuysCountInFirstMinute) {
        const msg = `Pool: ${validationResults.pool.id}, mintTx: ${txId}.\nNot GREEN token and Very little BUY txs ${validationResults.trend!.buysCount}`
        console.log(msg)
        this.skippedPools.push(msg)
        return
      }
    }


    console.log(`Start trading for pool ${validationResults.pool.id}`)
    this.runningTradesCount++
    if (this.maxCountOfSimulteniousTradings < this.runningTradesCount) {
      this.maxCountOfSimulteniousTradings = this.runningTradesCount
    }
    console.log(`Running Traders - current: ${this.runningTradesCount}, max: ${this.maxCountOfSimulteniousTradings} `)
    const tradeResults: SellResults = await this.traderPool.run(validationResults)
    this.completedTrades.push(`Pool: ${validationResults.pool.id}, mintTx: ${txId}.\nTrading resulst: ${JSON.stringify(tradeResults)}`)
    if (this.onLogsSubscriptionId === null) { return }
    this.runningTradesCount--
    console.log(`Running Traders - current: ${this.runningTradesCount}, max: ${this.maxCountOfSimulteniousTradings} `)
    console.log(`Pool ${validationResults.pool.id}, trading results: ${JSON.stringify(tradeResults)} `)

    this.updateWSOLBalance(tradeResults)

    console.log(chalk.yellow('Got trading results'))
  }
}