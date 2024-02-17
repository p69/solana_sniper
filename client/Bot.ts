import * as fs from 'fs'
import * as util from 'util'
import { Connection, PublicKey } from '@solana/web3.js';
import path from 'path';
import Piscina from 'piscina';
import { findLogEntry } from './PoolValidator/RaydiumPoolParser';
import chalk from 'chalk';
import { ValidatePoolData } from './PoolValidator/RaydiumPoolValidator';
import { PoolValidationResults } from './PoolValidator/ValidationResult';
import { delay } from './Utils';
import { config } from './Config';
// Specify the log file path
const log_fil_sufix = 2
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

const validatorPool = new Piscina({
  filename: path.resolve(__dirname, './PoolValidator/RaydiumPoolValidator.js')
});

const traderPool = new Piscina({
  filename: path.resolve(__dirname, './Trader/Trader.js')
})

const seenTransactions = new Set();

const TEST_TX = '3ha4QStA5dwLyn2FL5v4UYLi3GQypfX8XXuJm5B67M1FqkafVqw71zPkSWkB2otapzquSNWEUN4NeLRPgKmsjm8B'

async function handleNewPoolMintTx(txId: string) {
  console.log(chalk.yellow(`Find pool with tx - ${txId} Sending to Validator`))
  const msg: ValidatePoolData = {
    mintTxId: txId,
    date: new Date()
  }

  let validationResults: PoolValidationResults | string = await validatorPool.run(msg)
  if (typeof validationResults === `string`) {
    console.log(`Failed to validate with error: ${validationResults}`)
    // Notify state listener onPoolValidationFailed
    return
  }

  console.log(chalk.yellow(`Validation results for pool ${validationResults.pool.id}`))
  if (validationResults.startTimeInEpoch) {
    console.log(`Pool is postoned.`)
    console.log(`START TIME: ${validationResults.startTimeInEpoch}`)
    const delayBeforeStart = (validationResults.startTimeInEpoch * 1000) - Date.now()
    const maxTimeToWait = 24 * 60 * 60 * 1000
    console.log(`Pool ${validationResults.pool.id} starts in ${delayBeforeStart / 1000} seconds`)
    if (delayBeforeStart > 0 && delayBeforeStart < maxTimeToWait) {
      console.log(`Wait until it starts`)
      await delay(delayBeforeStart + 300)
      validationResults = await validatorPool.run(msg)
      console.log(`Got updated results`)
    } else {
      console.log(`It's too long, don't wait. Need to add more robust scheduler`)
    }
  }

  if (typeof validationResults === `string`) {
    console.log(`Failed to validate with error: ${validationResults}`)
    // Notify state listener onPoolValidationFailed
    return
  }

  console.log(JSON.stringify(validationResults.pool, null, 2))
  console.log(JSON.stringify(validationResults.poolFeatures, null, 2))
  console.log(JSON.stringify(validationResults.safetyStatus, null, 2))
  console.log(JSON.stringify(validationResults.reason, null, 2))
  // Notify state listener onPoolValidationCompleted

  if (validationResults.safetyStatus === 'RED') {
    console.log(chalk.red('Red token. Skipping'))
    return
  }

  const tradeResults = await traderPool.run(validationResults)

  console.log(chalk.yellow('Got trading results'))
  console.log(JSON.stringify(tradeResults, null, 2))
}

async function main() {
  /* Uncomment to perform single buy/sell test with predifined pool */
  // await handleNewPoolMintTx(TEST_TX)
  // return;
  /* Uncomment to perform single buy/sell test with predifined pool */

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