import { Connection, Logs, PublicKey } from '@solana/web3.js';
import { findLogEntry } from './PoolValidator/RaydiumPoolParser';
import chalk from 'chalk';
import { parsePoolCreationTx, ParsedPoolCreationTx, checkIfPoolPostponed, checkIfSwapEnabled } from './PoolValidator/RaydiumPoolValidator';
import { config } from './Config';
import { SellResults } from './Trader/SellToken';
import { SOL_SPL_TOKEN_ADDRESS } from './Trader/Addresses';
import { tryPerformTrading } from './Trader/Trader';
import { checkToken } from './PoolValidator/RaydiumSafetyCheck';
import { TradingWallet } from './StateAggregator/StateTypes';


const RAYDIUM_PUBLIC_KEY = '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8';

const LOW_LP_IN_USD = 500;
const HIGH_LP_IN_USD = 100000000;

export class TurboBot {
  private seenTxs = new Set<string>()
  private onLogsSubscriptionId: number | null = null
  private connection: Connection
  private tradingWallet: TradingWallet = {
    id: 0,
    startValue: 1,
    current: 1,
    totalProfit: 0
  }

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
      //updateTradingWalletRecord(this.tradingWallet)
    }
  }

  private async fetchInitialWalletSOLBalance() {
    //if (config.simulateOnly) { return }
    console.log(`Fetching wallet balance`)
    const balance = ((await this.connection.getTokenAccountBalance(SOL_SPL_TOKEN_ADDRESS)).value.uiAmount ?? 0)
    console.log(`Balance is ${balance}`)
    this.tradingWallet.current = balance
    this.tradingWallet.startValue = balance
  }

  async start(singleTrade: boolean = false) {
    return new Promise<void>(async (resolve, reject) => {
      console.log(`Start Solana bot. Simulation=${config.simulateOnly}`)
      await this.fetchInitialWalletSOLBalance()
      console.log(`Wallet:\n${JSON.stringify(this.tradingWallet, null, 2)}`)

      const raydium = new PublicKey(RAYDIUM_PUBLIC_KEY);

      let isCheckingPool = false
      this.onLogsSubscriptionId = this.connection.onLogs(raydium, async (txLogs) => {
        console.log(`Log received. ${txLogs.signature}`)
        if (isCheckingPool || this.seenTxs.has(txLogs.signature)) { return }
        isCheckingPool = true
        this.seenTxs.add(txLogs.signature)
        const parsedInfo = await this.parseTx(txLogs)
        if (!parsedInfo) {
          isCheckingPool = false
          return
        }
        const check = await checkToken(this.connection, parsedInfo, true)
        if (check.kind === 'CreatorIsScammer') {
          console.log(`Pool ${parsedInfo.poolKeys.id} - creator is known scammer`)
          isCheckingPool = false
          return
        }

        if (check.kind !== 'Complete') {
          console.log(`Pool ${parsedInfo.poolKeys.id} discarded`)
          isCheckingPool = false
          return
        }

        if (check.data.totalLiquidity.amountInUSD < LOW_LP_IN_USD || check.data.totalLiquidity.amountInUSD > HIGH_LP_IN_USD) {
          console.log(`Pool ${parsedInfo.poolKeys.id} - Liquidity is too low or too high. ${check.data.totalLiquidity.amount} ${check.data.totalLiquidity.symbol}`)
          isCheckingPool = false
          return
        }

        if (check.data.ownershipInfo.isMintable) {
          console.log(`Pool ${parsedInfo.poolKeys.id} - token is mintable`)
          isCheckingPool = false
          return
        }

        const tradeResults = await tryPerformTrading(this.connection, check.data.pool, 'TURBO')
        console.log(chalk.yellow('Got trading results'))
        this.updateWSOLBalance(tradeResults)
        if (singleTrade) {
          this.connection.removeOnLogsListener(this.onLogsSubscriptionId ?? 0)
          this.onLogsSubscriptionId = null
          resolve()
        }
        isCheckingPool = false
      })
    })
  }

  private async parseTx(txLogs: Logs): Promise<ParsedPoolCreationTx | null> {
    const logEntry = findLogEntry('init_pc_amount', txLogs.logs)
    if (!logEntry) { return null }
    try {
      const info = await parsePoolCreationTx(this.connection, txLogs.signature)
      const postponeInfo = checkIfPoolPostponed(info)
      if (postponeInfo.startTime) {
        console.log(`Pool ${info.poolKeys.id} is postponed`)
        return null
      }
      const isEnabled = checkIfSwapEnabled(info).isEnabled
      if (!isEnabled) {
        console.log(`Pool ${info.poolKeys.id} is disabled`)
        return null
      }
      return info
    } catch (e) {
      console.error(`Failed to parse tx. ${e}`)
      return null
    }
  }

}