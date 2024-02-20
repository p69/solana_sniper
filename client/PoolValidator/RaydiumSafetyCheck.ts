import { ParsedTransactionWithMeta, PublicKey, Connection, TokenBalance } from '@solana/web3.js'
import { LiquidityPoolKeysV4, WSOL } from '@raydium-io/raydium-sdk'
import { AccountLayout, getAssociatedTokenAddressSync, MINT_SIZE, MintLayout } from '@solana/spl-token'
import { BURN_ACC_ADDRESS } from './Addresses'
import { KNOWN_SCAM_ACCOUNTS } from './BlackLists'
import { BN } from "@project-serum/anchor";
import chalk from 'chalk'
import { delay, timeout } from '../Utils'
import { connection } from './Connection'
import { error } from 'console'

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
  isliquidityLocked: boolean,
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


  let isLiquidityLocked = await checkIfLPTokenBurnedWithRetry(3, 500, new PublicKey(lpTokenMint))

  // Liqidity is not locked, but more than half of supply is in pool
  // Possible that LP token wiill be burned later. Wait for a few hours
  if (!isLiquidityLocked && newTokenPoolBalancePercent >= 0.5) {
    console.log(chalk.cyan(`All tokens are in pool, but LP tokens aren't burned yet. Start verifying it`))
    isLiquidityLocked = await checkLPTokenBurnedOrTimeout(
      new PublicKey(lpTokenMint),
      2 * 60 * 60 * 1000
    )

    const lastOtherTokenInfo = await connection.getAccountInfo(otherTokenMint)
    const updatedMintInfo = MintLayout.decode(lastOtherTokenInfo!.data!.subarray(0, MINT_SIZE))
    const lastTotalSupply = Number(updatedMintInfo.supply) / (10 ** updatedMintInfo.decimals)
    const updatedMintAuthority = updatedMintInfo.mintAuthorityOption > 0 ? updatedMintInfo.mintAuthority : null

    tokenSupplyIsNotChanged = lastTotalSupply === totalSupply
    mintAuthority = updatedMintAuthority
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
    isliquidityLocked: isLiquidityLocked,
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

async function checkLPTokenBurnedOrTimeout(
  lpTokenMint: PublicKey,
  timeoutInMillis: number,
): Promise<boolean> {
  let isBurned = false
  try {
    await Promise.race([
      listenToLPTokenSupplyChanges(lpTokenMint),
      timeout(timeoutInMillis)
    ])

    return isBurned
  } catch (e) {
    console.log(`Timeout happened during refreshing burned LP tokens percent`)
    return isBurned
  }
}

async function listenToLPTokenSupplyChanges(
  lpTokenMint: PublicKey,
) {
  console.log(`Subscribing to LP mint changes. Waiting to burn. Mint: ${lpTokenMint.toString()}`)
  return new Promise<void>((resolve, reject) => {
    connection.onAccountChange(lpTokenMint, (accInfoBuffer, _) => {
      const lpTokenMintInfo = MintLayout.decode(accInfoBuffer.data.subarray(0, MINT_SIZE))
      const lastSupply = Number(lpTokenMintInfo.supply) / (10 ** lpTokenMintInfo.decimals)
      console.log(`LP token mint ${lpTokenMint.toString()} changed. Current supply: ${lastSupply}`)
      const isBurned = lastSupply <= 100
      if (isBurned) {
        resolve()
      }
    })
  })
}

async function checkIfLPTokenBurnedWithRetry(
  attempts: number,
  waitBeforeAttempt: number,
  lpTokenMint: PublicKey,
): Promise<boolean> {
  let attempt = 1
  while (attempt <= attempts) {
    try {
      const supply = await getTokenSupply(lpTokenMint)
      if (supply <= 100) {
        return true
      }
      attempt += 1
      if (attempt > attempts) { return false }
      await delay(200 + waitBeforeAttempt)
    } catch (e) {
      console.log(chalk.red(`Failed to get LP token supply: ${e}.`))
      attempt += 1
      if (attempt > attempts) { return false }
      await delay(200 + waitBeforeAttempt)
    }
  }
  return false
}

async function getTokenSupply(
  tokenMint: PublicKey
): Promise<number> {
  const accountInfo = await connection.getAccountInfo(tokenMint)
  if (!accountInfo) {
    throw error('Couldnt get token mint info')
  }
  const lpTokenMintInfo = MintLayout.decode(accountInfo.data.subarray(0, MINT_SIZE))
  const lastSupply = Number(lpTokenMintInfo.supply) / (10 ** lpTokenMintInfo.decimals)
  return lastSupply
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