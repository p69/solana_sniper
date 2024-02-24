import { Connection, Logs, PublicKey } from '@solana/web3.js';
import { PoolKeys, fetchPoolKeysForLPInitTransactionHash, findLogEntry } from './PoolValidator/RaydiumPoolParser';
import chalk from 'chalk';
import { ValidatePoolData, PoolValidationResults, parsePoolCreationTx, PoolPostponed, ParsedPoolCreationTx, checkIfPoolPostponed, checkIfSwapEnabled, evaluateSafetyState, checkLatestTrades, TradingInfo } from './PoolValidator/RaydiumPoolValidator';
import { delay, formatDate } from './Utils';
import { config } from './Config';
import { SellResults } from './Trader/SellToken';
import { SOL_SPL_TOKEN_ADDRESS } from './Trader/Addresses';
import { tryPerformTrading } from './Trader/Trader';
import { EMPTY, Observable, Subject, buffer, bufferCount, concatWith, distinct, empty, filter, from, iif, map, mergeAll, mergeMap, onErrorResumeNextWith, single, switchMap, timeInterval, windowCount } from 'rxjs';
import { checkLPTokenBurnedOrTimeout, checkToken, getTokenOwnershipInfo, PoolSafetyData, SafetyCheckComplete, SafetyCheckResult, WaitLPBurning, WaitLPBurningComplete, WaitLPBurningTooLong } from './PoolValidator/RaydiumSafetyCheck';
import { LiquidityPoolKeysV4, WSOL } from '@raydium-io/raydium-sdk';
import { MINT_SIZE, MintLayout } from '@solana/spl-token';
import { boolean } from 'yargs';
import { TokenSafetyStatus } from './PoolValidator/ValidationResult';

const RAYDIUM_PUBLIC_KEY = '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8';

type WaitingLPMintTooLong = {
  kind: 'TO_LONG',
  data: ParsedPoolCreationTx
}

type WaitingLPMintOk = {
  kind: 'OK',
  data: ParsedPoolCreationTx
}

type WaitingLPMint = WaitingLPMintTooLong | WaitingLPMintOk

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
  validationSub: any;
  parseResSub: any;
  pushToTradingTrendSub: any;
  tradingSub: any;


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

  private raydiumLogsSubject = new Subject<Logs>()
  private postponedPoolsSubject = new Subject<PoolPostponed>()
  private readyToSafetyCheckSubject = new Subject<ParsedPoolCreationTx>()
  private waitingLPToBurnPoolsSubject = new Subject<WaitLPBurning>()
  private safetyCheckCompleteSubject = new Subject<SafetyCheckComplete | WaitLPBurningComplete>()
  private readyToTradeSubject = new Subject<{ status: TokenSafetyStatus, data: PoolSafetyData }>()
  private skippedPoolsSubject = new Subject<{ data: ParsedPoolCreationTx | PoolSafetyData, reason: string }>()
  private NEW_POOLS_BUFFER = 10
  async start() {

    console.log(`Start Solana bot. Simulation=${config.simulateOnly}`)

    await this.fetchInitialWalletSOLBalance()

    console.log(`Wallet:\n${JSON.stringify(this.tradingWallet, null, 2)}`)

    const raydium = new PublicKey(RAYDIUM_PUBLIC_KEY);

    this.onLogsSubscriptionId = this.connection.onLogs(raydium, async (txLogs) => {
      this.raydiumLogsSubject.next(txLogs)
    })

    const parseNewIcomingObservable = this.raydiumLogsSubject
      .pipe(
        distinct((x) => x.signature),
        filter((x) => findLogEntry('init_pc_amount', x.logs) !== null),
        map(x => x.signature),
        mergeMap((txId) => from(parsePoolCreationTx(this.connection, txId)), 5),
        map(x => checkIfPoolPostponed(x)),
        map(x => { return { ...x, isEnabled: checkIfSwapEnabled(x.parsed).isEnabled } })
      )

    this.parseResSub = parseNewIcomingObservable.subscribe(parseResults => {
      if (parseResults.startTime) {
        this.postponedPoolsSubject.next({ kind: 'Postponed', parsed: parseResults.parsed, startTime: parseResults.startTime })
      } else if (parseResults.isEnabled) {
        this.readyToSafetyCheckSubject.next(parseResults.parsed)
      } else {
        this.skippedPoolsSubject.next({ data: parseResults.parsed, reason: 'Swapping is disabled' })
      }
    })

    const postponedObservable = this.postponedPoolsSubject.pipe(
      switchMap(x => from(this.waitUntilPoolStartsAndNotify(x.parsed, x.startTime)))
    )

    this.validationSub = this.readyToSafetyCheckSubject
      .pipe(
        map(x => {
          const obj: WaitingLPMint = { kind: 'OK', data: x }
          return obj
        }),
        concatWith(postponedObservable),
        windowCount(this.NEW_POOLS_BUFFER),
        mergeAll(),
        mergeMap(parsed => {
          switch (parsed.kind) {
            case 'OK': {
              return from(checkToken(this.connection, parsed.data))
            }
            case 'TO_LONG': {
              const obj: WaitLPBurningTooLong = {
                kind: 'WaitLPBurningTooLong',
                data: parsed.data
              }
              return from([obj])
            }
          }
        }, 3)
      )
      .subscribe({
        next: safetyCheckResults => {
          switch (
          safetyCheckResults.kind) {
            case 'CreatorIsScammer': {
              const msg = `Pool ${safetyCheckResults.pool.poolKeys.id} Skipped because creator ${safetyCheckResults.pool.creator.toString()} is in blacklist.`
              this.skippedPoolsSubject.next({ data: safetyCheckResults.pool, reason: msg })
              break
            }
            case 'WaitLPBurningTooLong': {
              const msg = `Pool ${safetyCheckResults.data.poolKeys.id} Skipped because it's postponed for too long.`
              this.skippedPoolsSubject.next({ data: safetyCheckResults.data, reason: msg })
              break
            }
            case 'WaitLPBurning': {
              this.waitingLPToBurnPoolsSubject.next(safetyCheckResults)
              break
            }
            case 'Complete': {
              this.safetyCheckCompleteSubject.next(safetyCheckResults)
              break
            }
          }
        },
        error: error => {
          console.error(error)
        }
      })

    const waitLPBurnedObservable: Observable<WaitLPBurningComplete> = this.waitingLPToBurnPoolsSubject.pipe(
      mergeMap(x => from(this.waitUntilLPTokensAreBurned(x.data, x.lpTokenMint)), 10),
      mergeMap(x => from(getTokenOwnershipInfo(this.connection, x.data.tokenMint))
        .pipe(
          map(res => { return { ...x, data: { ...x.data, ownershipInfo: res } } })
        )
      )
    )

    this.pushToTradingTrendSub = this.safetyCheckCompleteSubject.pipe(
      concatWith(waitLPBurnedObservable),
      map(x => evaluateSafetyState(x.data, x.isliquidityLocked)),
      switchMap(data => {
        if (data.status === 'RED') {
          return EMPTY
        } else {
          return from(checkLatestTrades(this.connection, data.data.pool))
            .pipe(
              map(x => { return { data: data.data, status: data.status, statusReason: data.reason, tradingInfo: x } })
            )
        }
      })
    )
      .subscribe({
        next: data => {
          this.checkTokenStatusAndTradingTrend({ pool: data.data, safetyStatus: data.status, statusReason: data.statusReason, tradingInfo: data.tradingInfo })
        },
        error: e => {
          console.error(`${e}`)
        }
      })


    this.tradingSub = this.readyToTradeSubject
      .pipe(
        mergeMap(x =>
          from(tryPerformTrading(this.connection, x.data.pool, x.status))
            .pipe(map(tr => { return { poolData: x.data, results: tr } }))
        )
      )
      .subscribe({
        next: x => this.onTradingResults(x.poolData.pool.id.toString(), x.results),
        error: e => {
          console.error(`${e}`)
        }
      })


    console.log(chalk.cyan('Listening to new pools...'))
  }

  private checkTokenStatusAndTradingTrend(data: { pool: PoolSafetyData, safetyStatus: TokenSafetyStatus, statusReason: string, tradingInfo: TradingInfo }) {
    if (data.safetyStatus === 'RED') {
      // Should be verified and filterd out earlier
      return
    }

    if (data.tradingInfo.dump) {
      const log = `Already dumped. TX1: https://solscan.io/tx/${data.tradingInfo.dump[0].signature} TX2:TX1: https://solscan.io/tx/${data.tradingInfo.dump[1].signature}`
      this.skippedPoolsSubject.next({ data: data.pool, reason: log })
      return
    }

    const tradingAnalisis = data.tradingInfo.analysis
    if (!tradingAnalisis) {
      this.skippedPoolsSubject.next({ data: data.pool, reason: `Couldn't fetch trades` })
      return
    }

    if (data.safetyStatus === 'GREEN') {
      if (tradingAnalisis.type === 'PUMPING' || tradingAnalisis.type === 'EQUILIBRIUM') {
        this.readyToTradeSubject.next({ status: data.safetyStatus, data: data.pool })
      } else {
        this.skippedPoolsSubject.next({ data: data.pool, reason: `Trend is DUMPING` })
      }

      return
    }

    if (tradingAnalisis.type !== 'PUMPING') {
      this.skippedPoolsSubject.next({ data: data.pool, reason: `Trend is DUMPING` })
      return
    }

    if (tradingAnalisis.volatility > config.safePriceValotilityRate) {
      const msg = `Not GREEN token and Price volatility is to high ${tradingAnalisis.volatility}`
      this.skippedPoolsSubject.next({ data: data.pool, reason: msg })
      return
    }

    if (tradingAnalisis.buysCount < config.safeBuysCountInFirstMinute) {
      const msg = `Not GREEN token and Very little BUY txs ${tradingAnalisis.buysCount}`
      this.skippedPoolsSubject.next({ data: data.pool, reason: msg })
      return
    }

    this.readyToTradeSubject.next({ status: data.safetyStatus, data: data.pool })
  }

  async waitUntilPoolStartsAndNotify(parsed: ParsedPoolCreationTx, startTime: number): Promise<WaitingLPMint> {
    const delayBeforeStart = (startTime * 1000) - Date.now()
    const maxTimeToWait = 24 * 60 * 60 * 1000
    if (delayBeforeStart > 0 && delayBeforeStart < maxTimeToWait) {
      console.log(`Wait until it starts`)
      await delay(delayBeforeStart + 300)
      return { kind: 'OK', data: parsed }
    } else {
      return { kind: 'TO_LONG', data: parsed }
    }
  }

  async waitUntilLPTokensAreBurned(safetyData: PoolSafetyData, lpTokenMint: PublicKey): Promise<WaitLPBurningComplete> {
    const isLiquidityLocked = await checkLPTokenBurnedOrTimeout(
      this.connection,
      lpTokenMint,
      2 * 60 * 60 * 1000
    )
    return { kind: 'WaitLPBurningComplete', isliquidityLocked: isLiquidityLocked, data: safetyData }
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
}