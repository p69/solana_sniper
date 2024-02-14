import * as dotenv from 'dotenv'
dotenv.config()
import { Connection, PublicKey } from '@solana/web3.js';
import path from 'path';
import Piscina from 'piscina';
import { findLogEntry } from './PoolValidator/RaydiumPoolParser';
import chalk from 'chalk';
import { ValidatePoolData } from './PoolValidator/RaydiumPoolValidator';
import { PoolValidationResults } from './PoolValidator/ValidationResult';

const RAYDIUM_PUBLIC_KEY = '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8';

const validatorPool = new Piscina({
  filename: path.resolve(__dirname, './PoolValidator/RaydiumPoolValidator.js')
});

const traderPool = new Piscina({
  filename: path.resolve(__dirname, './Trader/Trader.js')
})

const seenTransactions = new Set();

const TEST_TX = '3icAouyXwu9m2bkcGS6qRKmSsCdGBDqVQQW5HUFxnQoFyHcxrKSAixq8MB52ksZUPJym75w7MmcMxLUUh39Ucznh'

async function handleNewPoolMintTx(txId: string) {
  console.log(chalk.yellow(`Find pool with tx - ${txId} Sending to Validator`))
  const msg: ValidatePoolData = {
    mintTxId: txId,
    date: new Date()
  }

  const validationResults: PoolValidationResults = await validatorPool.run(msg)

  console.log(chalk.yellow(`Validation results`))
  console.log(JSON.stringify(validationResults, null, 2))
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

  const connection = new Connection(process.env.RPC_URL!, {
    wsEndpoint: process.env.WS_URL!
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