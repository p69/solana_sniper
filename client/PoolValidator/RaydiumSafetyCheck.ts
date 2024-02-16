import { ParsedTransactionWithMeta, PublicKey, Connection, TokenBalance } from '@solana/web3.js'
import { LiquidityPoolKeysV4, WSOL } from '@raydium-io/raydium-sdk'
import { getAssociatedTokenAddressSync, MINT_SIZE, MintLayout } from '@solana/spl-token'
import { BURN_ACC_ADDRESS } from './Addresses'
import { KNOWN_SCAM_ACCOUNTS } from './BlackLists'
import { BN } from "@project-serum/anchor";
import chalk from 'chalk'
import { delay, timeout } from '../Utils'
import { connection } from './Connection'

const RAYDIUM_OWNER_AUTHORITY = '5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1';

type OwnershipInfo = {
  mintAuthority: string | null,
  freezeAuthority: string | null,
  isMintable: boolean,
  authorityBalancePercent: number
}

type LiquidityValue = {
  amount: number,
  amountInUSD: number,
  symbol: string
}

export type SafetyCheckResult = {
  creator: PublicKey,
  newTokensWereMintedDuringValidation: boolean,
  totalLiquidity: LiquidityValue,
  lockedPercentOfLiqiodity: number,
  newTokenPoolBalancePercent: number,
  ownershipInfo: OwnershipInfo,
}

export async function checkToken(tx: ParsedTransactionWithMeta, pool: LiquidityPoolKeysV4): Promise<SafetyCheckResult | null> {
  if (!tx.meta || !tx.meta.innerInstructions || !tx.meta.preTokenBalances || !tx.meta.postTokenBalances) {
    console.log(`meta is null ${tx.meta === null}`)
    console.log(`innerInstructions is null ${tx.meta?.innerInstructions === null || tx.meta?.innerInstructions === undefined}`)
    console.log(`post balances is null ${tx.meta?.postTokenBalances === null || tx.meta?.postTokenBalances === undefined}`)
    return null
  }

  const firstInnerInstructionsSet = tx.meta.innerInstructions[0].instructions as any[]
  const creatorAddress = new PublicKey(firstInnerInstructionsSet[0].parsed.info.source)

  /// Check blacklist first
  if (KNOWN_SCAM_ACCOUNTS.has(creatorAddress.toString())) {
    console.log(`Creater blacklisted ${creatorAddress.toString()}`)
    return null
  }

  const baseIsWSOL = pool.baseMint.toString() === WSOL.mint
  const otherTokenMint = baseIsWSOL ? pool.quoteMint : pool.baseMint

  /// Check mint and freeze authorities
  /// Ideally `not set`
  /// Not to bad if address is not cretor's
  /// Red-flag if addresses is the same as creator's
  const otherTokenInfo = await connection.getAccountInfo(otherTokenMint)
  const mintInfo = MintLayout.decode(otherTokenInfo!.data!.subarray(0, MINT_SIZE))
  const totalSupply = Number(mintInfo.supply) / (10 ** mintInfo.decimals)
  let mintAuthority = mintInfo.mintAuthorityOption > 0 ? mintInfo.mintAuthority : null
  const freezeAuthority = mintInfo.freezeAuthorityOption > 0 ? mintInfo.freezeAuthority : null
  let tokenSupplyIsNotChanged = true

  /// Check creators and authorities balances
  const calcOwnershipPercent = async (address: PublicKey) => {
    const tokenAcc = getAssociatedTokenAddressSync(otherTokenMint, address)
    const value = (await connection.getTokenAccountBalance(tokenAcc)).value.uiAmount ?? 0
    return value / totalSupply
  }

  const creatorsPercentage = await calcOwnershipPercent(creatorAddress)
  let authorityPercentage: number = 0
  if (mintAuthority) {
    authorityPercentage = await calcOwnershipPercent(mintAuthority)
  } else if (freezeAuthority) {
    authorityPercentage = await calcOwnershipPercent(freezeAuthority)
  }

  ///Check largest holders
  /// Should Raydiium LP
  const largestAccounts = await connection.getTokenLargestAccounts(otherTokenMint);
  const raydiumTokenAccount = await connection.getParsedTokenAccountsByOwner(new PublicKey(RAYDIUM_OWNER_AUTHORITY), { mint: otherTokenMint });

  let newTokenPoolBalancePercent = 0
  if (largestAccounts.value.length > 0 && raydiumTokenAccount.value.length > 0) {
    const poolAcc = raydiumTokenAccount.value[0].pubkey.toString()
    const poolBalance = largestAccounts.value.find(x => x.address.toString() === poolAcc)
    if (poolBalance) {
      newTokenPoolBalancePercent = (poolBalance.uiAmount ?? 0) / totalSupply
    }
  }

  /// Find LP-token minted by providing liquidity to the pool
  /// Serves as a permission to remove liquidity
  const preBalanceTokens = reduceBalancesToTokensSet(tx.meta.preTokenBalances)
  const postBalanceTokens = reduceBalancesToTokensSet(tx.meta.postTokenBalances)
  let lpTokenMint: string | null = null
  for (let x of postBalanceTokens) {
    if (!preBalanceTokens.has(x)) {
      lpTokenMint = x
      break
    }
  }

  if (lpTokenMint === null) {
    /// NO LP tokens
    console.log(`No LP tokens`)
    return null
  }

  /// LP tokens balance right after first mint transaction
  const mintTxLPTokenBalance = tx.meta.postTokenBalances.find(x => x.mint === lpTokenMint)!

  const lpTokenAccount = getAssociatedTokenAddressSync(new PublicKey(lpTokenMint), creatorAddress)

  let percentLockedLP: number

  if ((mintTxLPTokenBalance.uiTokenAmount.uiAmount ?? 0) <= 1) {
    percentLockedLP = 1
  } else {
    // If all tokens were transfered to the pool
    // Verify burned LP tokens for few hours every 5 minutes
    // Could be a gem
    if (newTokenPoolBalancePercent >= 0.99) {
      console.log(chalk.cyan(`All tokens are in pool, but LP tokens aren't burned yet. Start verifying it every 5 minutes`))
      const updatedData = await checkMintAuthorityAndBurnedTokensOrTimeout(
        mintAuthority?.toString() ?? null,
        lpTokenAccount,
        lpTokenMint,
        mintTxLPTokenBalance,
        otherTokenMint,
        2 * 60 * 60 * 1000
      )
      if (updatedData !== null) {
        if (updatedData.updatedSupply) {
          tokenSupplyIsNotChanged = updatedData.updatedSupply === totalSupply
        }
        mintAuthority = updatedData.mint !== null ? new PublicKey(updatedData.mint) : null
        percentLockedLP = updatedData.burnedLPPercent
      } else {
        percentLockedLP = 0
      }
    } else {
      percentLockedLP = await getPercentOfBurnedTokensWithRetry(
        11, /// 4 attempts
        30 * 1000, /// wait for 30 seconds before next retry
        lpTokenAccount,
        lpTokenMint,
        mintTxLPTokenBalance
      )
    }
  }

  /// Check if supply was changed during LP tokens validation
  if (tokenSupplyIsNotChanged) {
    const lastOtherTokenInfo = await connection.getAccountInfo(otherTokenMint)
    const lastMintInfo = MintLayout.decode(lastOtherTokenInfo!.data!.subarray(0, MINT_SIZE))
    const lastSupply = Number(lastMintInfo.supply) / (10 ** lastMintInfo.decimals)
    tokenSupplyIsNotChanged = totalSupply === lastSupply
  }

  /// Get real liquiidity value
  const realCurrencyLPBalance = await connection.getTokenAccountBalance(baseIsWSOL ? pool.baseVault : pool.quoteVault);
  //const lpVaultBalance = await connection.getTokenAccountBalance(poolKeys.lpVault);
  const SOL_EXCHANGE_RATE = 110 /// With EXTRA as of 08.02.2024
  const liquitity = realCurrencyLPBalance.value.uiAmount ?? 0;
  const isSOL = realCurrencyLPBalance.value.decimals === WSOL.decimals;
  const symbol = isSOL ? 'SOL' : 'USD';
  const amountInUSD = isSOL ? liquitity * SOL_EXCHANGE_RATE : liquitity

  console.log(chalk.bgBlue(`Real Liquidity ${liquitity} ${symbol}`));

  return {
    creator: creatorAddress,
    lockedPercentOfLiqiodity: percentLockedLP,
    newTokensWereMintedDuringValidation: false,
    totalLiquidity: {
      amount: liquitity,
      amountInUSD,
      symbol
    },
    newTokenPoolBalancePercent,
    ownershipInfo: {
      mintAuthority: mintAuthority?.toString() ?? null,
      freezeAuthority: freezeAuthority?.toString() ?? null,
      isMintable: mintAuthority !== null,
      authorityBalancePercent: authorityPercentage
    }
  }
}

function reduceBalancesToTokensSet(balances: TokenBalance[]): Set<string> {
  const result = new Set<string>()
  return balances.reduce((set, b) => {
    set.add(b.mint)
    return set
  }, result)
}

async function checkMintAuthorityAndBurnedTokensOrTimeout(
  latestMintAuthority: string | null,
  lpTokenAccount: PublicKey,
  lpTokenMint: string,
  mintTxLPTokenBalance: TokenBalance,
  otherTokenMint: PublicKey,
  timeoutInMillis: number,
): Promise<{ mint: string | null, burnedLPPercent: number, updatedSupply: number | null } | null> {
  try {
    const results = await Promise.race([
      checkMintAuthorityAndBurnedTokensInLoop(latestMintAuthority, lpTokenAccount, lpTokenMint, mintTxLPTokenBalance, otherTokenMint),
      timeout(timeoutInMillis)
    ])

    return results
  } catch (e) {
    console.log(`Timeout happened during refreshing burned LP tokens percent`)
    return null
  }
}

async function checkMintAuthorityAndBurnedTokensInLoop(
  latestMintAuthority: string | null,
  lpTokenAccount: PublicKey,
  lpTokenMint: string,
  mintTxLPTokenBalance: TokenBalance,
  otherTokenMint: PublicKey,
  delayBetweenRetryesInMillis: number = 5 * 60 * 1000 // retry every 5 minutes
): Promise<{ mint: string | null, burnedLPPercent: number, updatedSupply: number | null }> {
  while (true) {
    try {
      const burnedPercent = await getPercentOfBurnedTokensWithRetry(1, 0, lpTokenAccount, lpTokenMint, mintTxLPTokenBalance)
      if (burnedPercent < 0.99) {
        await delay(delayBetweenRetryesInMillis)
        continue
      }

      if (latestMintAuthority === null) {
        return { mint: latestMintAuthority, burnedLPPercent: burnedPercent, updatedSupply: null }
      }

      const otherTokenInfo = await connection.getAccountInfo(otherTokenMint)
      const mintInfo = MintLayout.decode(otherTokenInfo!.data!.subarray(0, MINT_SIZE))
      const totalSupply = Number(mintInfo.supply) / (10 ** mintInfo.decimals)
      const updatedMintAuthority = mintInfo.mintAuthorityOption > 0 ? mintInfo.mintAuthority : null
      return { mint: updatedMintAuthority?.toString() ?? null, burnedLPPercent: burnedPercent, updatedSupply: totalSupply }
    } catch (e) {
      console.log(chalk.red(`Failed to update burned tokens percent and mint info. ${e}`))
      console.log('Retrying')
      await delay(delayBetweenRetryesInMillis)
    }
  }
}

async function getPercentOfBurnedTokensWithRetry(
  attempts: number,
  waitBeforeAttempt: number,
  lpTokenAccount: PublicKey,
  lpTokenMint: string,
  mintTxLPTokenBalance: TokenBalance,
): Promise<number> {
  let attempt = 1
  while (attempt <= attempts) {
    try {
      const burnedPercent = await getPercentOfBurnedTokens(lpTokenAccount, lpTokenMint, mintTxLPTokenBalance)
      if (burnedPercent >= 1) {
        return burnedPercent
      }
      attempt += 1
      if (attempt > attempts) { return 0 }
      await delay(200 + waitBeforeAttempt)
    } catch (e) {
      console.log(chalk.red(`Failed to get amount of burned LP tokens: ${e}.`))
      attempt += 1
      if (attempt > attempts) { return 0 }
      await delay(200 + waitBeforeAttempt)
    }
  }
  return 0
}

const BURN_INSTRCUTIONS = new Set(['burnChecked', 'burn'])

async function getPercentOfBurnedTokens(
  lpTokenAccount: PublicKey,
  lpTokenMint: string,
  mintTxLPTokenBalance: TokenBalance,
): Promise<number> {
  const lpTokenAccountTxIds = await connection.getConfirmedSignaturesForAddress2(lpTokenAccount)
  const lpTokenAccountTxs = await connection
    .getParsedTransactions(
      lpTokenAccountTxIds.map(x => x.signature),
      { maxSupportedTransactionVersion: 0 })

  const filteredLPTokenAccountTxs = lpTokenAccountTxs.filter(x => x && x.meta && !x.meta.err)

  /// Check for either BURN instruction
  /// Transferring to burn address
  let totalLPTokensBurned: number = 0
  for (let i = 0; i < filteredLPTokenAccountTxs.length; i++) {
    const parsedWithMeta = filteredLPTokenAccountTxs[i]
    if (!parsedWithMeta || !parsedWithMeta.meta) { continue }
    const preLPTokenBalance = parsedWithMeta.meta.preTokenBalances?.find(x => x.mint === lpTokenMint)
    const postLPTokenBalance = parsedWithMeta.meta.postTokenBalances?.find(x => x.mint === lpTokenMint)
    const burnInstructions = parsedWithMeta.transaction
      .message.instructions
      .map((x: any) => x.parsed)
      .filter(x => x && BURN_INSTRCUTIONS.has(x.type) && x.info.mint === lpTokenMint)

    if (burnInstructions && burnInstructions.length > 0) {
      const amountBurned: BN = burnInstructions.reduce((acc: BN, x) => {
        const amount = x.info?.amount ?? x.info?.tokenAmount?.amount
        if (amount) {
          const currencyAmount = new BN(amount)
          return acc.add(currencyAmount)
        }
      }, new BN('0'))
      const burnedInHuman = amountBurned.toNumber() / (10 ** mintTxLPTokenBalance.uiTokenAmount.decimals)
      totalLPTokensBurned += burnedInHuman
    } else {
      const burnAddressInMessage = parsedWithMeta.transaction.message.accountKeys.find(x => x.pubkey.toString() === BURN_ACC_ADDRESS)
      if (burnAddressInMessage) {
        totalLPTokensBurned += (preLPTokenBalance?.uiTokenAmount.uiAmount ?? 0) - (postLPTokenBalance?.uiTokenAmount.uiAmount ?? 0)
      }
    }
  }

  return totalLPTokensBurned / (mintTxLPTokenBalance.uiTokenAmount.uiAmount ?? 1)
}