import * as fs from 'fs'
import * as util from 'util'
import { Connection, PublicKey } from '@solana/web3.js';
import path from 'path';
import Piscina from 'piscina';
import { findLogEntry } from './PoolValidator/RaydiumPoolParser';
import chalk from 'chalk';
import { ValidatePoolData } from './PoolValidator/RaydiumPoolValidator';
import { PoolValidationResults } from './PoolValidator/ValidationResult';
import { delay, formatDate } from './Utils';
import { config } from './Config';
import { SellResults } from './Trader/SellToken';
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

const mainActionsLogFilePath = path.join(__dirname, `/logs/actions.log`)
const mainActionslogFileStream = fs.createWriteStream(mainActionsLogFilePath, { flags: 'a' }); // 'a' flag for append mode
const logAction = (...args: any[]) => {
  const formattedTime = formatDate(new Date())
  // Format the message as console.log would
  const message = util.format.apply(null, args) + '\n';
  // Write the formatted message to the log file
  mainActionslogFileStream.write(`[${formattedTime}]: ${message}`);
}


const RAYDIUM_PUBLIC_KEY = '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8';

let tradingWallet: { startValue: number, current: number, totalProfit: number } = {
  startValue: 1,
  current: 1,
  totalProfit: 0
}

let runningTradesCount = 0
let maxCountOfSimulteniousTradings = 0
let runningValidatorsCount = 0
let maxCountOfSimulteniousValidators = 0
const VALIDATORS_LIMIT = 15

const validatorPool = new Piscina({
  filename: path.resolve(__dirname, './PoolValidator/RaydiumPoolValidator.js')
});

const traderPool = new Piscina({
  filename: path.resolve(__dirname, './Trader/Trader.js')
})

const seenTransactions = new Set();

const TEST_TX = '3ha4QStA5dwLyn2FL5v4UYLi3GQypfX8XXuJm5B67M1FqkafVqw71zPkSWkB2otapzquSNWEUN4NeLRPgKmsjm8B'

async function handleNewPoolMintTx(txId: string) {
  if (runningValidatorsCount === VALIDATORS_LIMIT) {
    console.log(chalk.yellow(`Find pool with tx - ${txId} but limit of ${VALIDATORS_LIMIT} has been reached. Skipped`))
    logAction(`Find pool with tx - ${txId} but limit of ${VALIDATORS_LIMIT} has been reached. Skipped`)
    return
  }
  console.log(chalk.yellow(`Find pool with tx - ${txId} Sending to Validator`))
  const msg: ValidatePoolData = {
    mintTxId: txId,
    date: new Date()
  }

  logAction(`Received first mint tx https://solscan.io/tx/${txId}`)
  runningValidatorsCount++
  if (runningValidatorsCount > maxCountOfSimulteniousValidators) {
    maxCountOfSimulteniousValidators = runningValidatorsCount
  }
  logAction(`Running Validators - current: ${runningValidatorsCount}, max: ${maxCountOfSimulteniousValidators}`)

  let validationResults: PoolValidationResults | string = await validatorPool.run(msg)
  runningValidatorsCount--

  if (typeof validationResults === `string`) {
    console.log(`Failed to validate with error: ${validationResults}`)
    logAction(`Failed to validate pool by first min tx https://solscan.io/tx/${txId}`)
    logAction(`Error: ${validationResults}`)
    // Notify state listener onPoolValidationFailed
    return
  }

  console.log(chalk.yellow(`Validation results for pool ${validationResults.pool.id}`))
  if (validationResults.startTimeInEpoch) {
    console.log(`Pool is postoned.`)
    console.log(`START TIME: ${validationResults.startTimeInEpoch}`)
    logAction(`Pool ${validationResults.pool.id} is postponed to ${formatDate(new Date(validationResults.startTimeInEpoch))}`)
    const delayBeforeStart = (validationResults.startTimeInEpoch * 1000) - Date.now()
    const maxTimeToWait = 24 * 60 * 60 * 1000
    console.log(`Pool ${validationResults.pool.id} starts in ${delayBeforeStart / 1000} seconds`)
    if (delayBeforeStart > 0 && delayBeforeStart < maxTimeToWait) {
      console.log(`Wait until it starts`)
      await delay(delayBeforeStart + 300)
      runningValidatorsCount++
      if (runningValidatorsCount > maxCountOfSimulteniousValidators) {
        maxCountOfSimulteniousValidators = runningValidatorsCount
      }
      logAction(`Running Validators - current: ${runningValidatorsCount}, max: ${maxCountOfSimulteniousValidators}`)
      validationResults = await validatorPool.run(msg)
      runningValidatorsCount--
      console.log(`Got updated results`)
    } else {
      console.log(`It's too long, don't wait. Need to add more robust scheduler`)
      runningValidatorsCount--
    }
  }

  logAction(`Received updated validation for postponed Pool TxId ${txId}`)
  if (typeof validationResults === `string`) {
    console.log(`Failed to validate with error: ${validationResults}`)
    logAction(`Error: ${validationResults}`)

    // Notify state listener onPoolValidationFailed
    return
  }

  console.log(JSON.stringify(validationResults.pool, null, 2))
  console.log(JSON.stringify(validationResults.poolFeatures, null, 2))
  console.log(JSON.stringify(validationResults.safetyStatus, null, 2))
  console.log(JSON.stringify(validationResults.reason, null, 2))
  // Notify state listener onPoolValidationCompleted
  logAction(`Token in pool ${validationResults.pool.id} is ${validationResults.safetyStatus}`)
  logAction(`Pool ${validationResults.pool.id} validation results reason is ${validationResults.reason}`)
  logAction(`Pool ${validationResults.pool.id} trend is ${JSON.stringify(validationResults.trend)}`)

  if (validationResults.safetyStatus === 'RED') {
    console.log(chalk.red('Red token. Skipping'))
    return
  }

  if (validationResults.safetyStatus !== 'GREEN') {
    if (validationResults.trend!.volatility > config.safePriceValotilityRate) {
      console.log(`Not GREEN token and Price volatility is to high ${validationResults.trend!.volatility}`)
      logAction(`Not GREEN token and Price volatility is to high ${validationResults.trend!.volatility}`)
      return
    }

    if (validationResults.trend!.buysCount < config.safeBuysCountInFirstMinute) {
      console.log(`Not GREEN token and Very little BUY txs ${validationResults.trend!.buysCount}`)
      logAction(`Not GREEN token and Very little BUY txs ${validationResults.trend!.buysCount}`)
      return
    }
  }


  logAction(`Start trading for pool ${validationResults.pool.id}`)
  runningTradesCount++
  if (maxCountOfSimulteniousTradings < runningTradesCount) {
    maxCountOfSimulteniousTradings = runningTradesCount
  }
  logAction(`Running Traders - current: ${runningTradesCount}, max: ${maxCountOfSimulteniousTradings}`)
  const tradeResults: SellResults = await traderPool.run(validationResults)
  runningTradesCount--
  logAction(`Running Traders - current: ${runningTradesCount}, max: ${maxCountOfSimulteniousTradings}`)
  logAction(`Pool ${validationResults.pool.id}, trading results: ${JSON.stringify(tradeResults)}`)

  if (tradeResults.boughtForSol) {
    const soldForSol = tradeResults.kind === 'SUCCESS' ? tradeResults.soldForSOL : 0
    const profitAbsolute = soldForSol - tradeResults.boughtForSol
    const newWalletBalance = tradingWallet.current + profitAbsolute
    const totalProfit = (newWalletBalance - tradingWallet.startValue) / tradingWallet.startValue
    tradingWallet = { ...tradingWallet, current: newWalletBalance, totalProfit }
    logAction(`Wallet:\n${JSON.stringify(tradingWallet, null, 2)}`)
    console.log(`Wallet:\n${JSON.stringify(tradingWallet, null, 2)}`)
  }

  console.log(chalk.yellow('Got trading results'))
  console.log(JSON.stringify(tradeResults, null, 2))
}

async function main() {
  /* Uncomment to perform single buy/sell test with predifined pool */
  // await handleNewPoolMintTx(TEST_TX)
  // return;
  /* Uncomment to perform single buy/sell test with predifined pool */

  console.log(`Start Solana bot. Simulation=${config.simulateOnly}`)
  logAction(`Start Solana bot. Simulation=${config.simulateOnly}`)
  logAction(`Wallet:\n${JSON.stringify(tradingWallet, null, 2)}`)
  console.log(`Wallet:\n${JSON.stringify(tradingWallet, null, 2)}`)

  const connection = new Connection(config.rpcHttpURL, {
    wsEndpoint: config.rpcWsURL
  })

  const raydium = new PublicKey(RAYDIUM_PUBLIC_KEY);

  connection.onLogs(raydium, async (txLogs) => {
    if (seenTransactions.has(txLogs.signature)) {
      return;
    }
    seenTransactions.add(txLogs.signature);
    if (!findLogEntry('init_pc_amount', txLogs.logs)) {
      return; // If "init_pc_amount" is not in log entries then it's not LP initialization transaction
    }

    await handleNewPoolMintTx(txLogs.signature)
  });
  console.log(chalk.cyan('Listening to new pools...'))
}

main().catch(console.error)