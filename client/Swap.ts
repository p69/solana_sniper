import { Fraction, Liquidity, LiquidityPoolKeysV4, Percent, Price, SOL, Token, TokenAccount, TokenAmount, WSOL } from "@raydium-io/raydium-sdk";
import { Connection, PublicKey, Commitment, TransactionMessage, ComputeBudgetProgram, VersionedTransaction } from "@solana/web3.js";
import {
  createAssociatedTokenAccountIdempotentInstruction
} from '@solana/spl-token';
import { Wallet } from '@project-serum/anchor'
import chalk from "chalk";
import { delay, lamportsToSOLNumber, timeout } from "./Utils";

export async function swapTokens(
  connection: Connection,
  poolKeys: LiquidityPoolKeysV4,
  tokenAccountIn: PublicKey,
  tokenAccountOut: PublicKey,
  signer: Wallet,
  amountIn: TokenAmount,
  commitment: Commitment = 'confirmed'
): Promise<string> {
  const otherTokenMint = (poolKeys.baseMint.toString() === WSOL.mint) ? poolKeys.quoteMint : poolKeys.baseMint;
  const associatedTokenAcc = (amountIn.token.mint.toString() === WSOL.mint) ? tokenAccountOut : tokenAccountIn;
  const { innerTransaction, address } = Liquidity.makeSwapFixedInInstruction(
    {
      poolKeys: poolKeys,
      userKeys: {
        tokenAccountIn: tokenAccountIn,
        tokenAccountOut: tokenAccountOut,
        owner: signer.publicKey,
      },
      amountIn: amountIn.raw,
      minAmountOut: 0,
    },
    poolKeys.version,
  );

  const latestBlockhash = await connection.getLatestBlockhash({
    commitment: commitment,
  });
  const messageV0 = new TransactionMessage({
    payerKey: signer.publicKey,
    recentBlockhash: latestBlockhash.blockhash,
    instructions: [
      ComputeBudgetProgram.setComputeUnitLimit({ units: 400000 }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 30000 }),
      createAssociatedTokenAccountIdempotentInstruction(
        signer.publicKey,
        associatedTokenAcc,
        signer.publicKey,
        otherTokenMint,
      ),
      ...innerTransaction.instructions,
    ],
  }).compileToV0Message();
  const transaction = new VersionedTransaction(messageV0);
  transaction.sign([signer.payer, ...innerTransaction.signers]);
  const signature = await connection.sendRawTransaction(
    transaction.serialize(),
    {
      maxRetries: 20,
      preflightCommitment: commitment,
    },
  );
  return signature;
}

export async function sellTokens(
  connection: Connection,
  poolKeys: LiquidityPoolKeysV4,
  quoteTokenAccount: TokenAccount,
  baseTokenAccount: TokenAccount,
  signer: Wallet,
  amountToSell: TokenAmount,
  commitment: Commitment = 'confirmed'
): Promise<string> {
  const { innerTransaction, address } = Liquidity.makeSwapFixedInInstruction(
    {
      poolKeys: poolKeys,
      userKeys: {
        tokenAccountIn: baseTokenAccount.pubkey,
        tokenAccountOut: quoteTokenAccount.pubkey,
        owner: signer.publicKey,
      },
      amountIn: amountToSell.raw,
      minAmountOut: 0,
    },
    poolKeys.version,
  );

  const latestBlockhash = await connection.getLatestBlockhash({
    commitment: commitment,
  });
  const messageV0 = new TransactionMessage({
    payerKey: signer.publicKey,
    recentBlockhash: latestBlockhash.blockhash,
    instructions: [
      ComputeBudgetProgram.setComputeUnitLimit({ units: 400000 }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 30000 }),
      createAssociatedTokenAccountIdempotentInstruction(
        signer.publicKey,
        baseTokenAccount.pubkey,
        signer.publicKey,
        baseTokenAccount.accountInfo.mint,
      ),
      ...innerTransaction.instructions,
    ],
  }).compileToV0Message();
  const transaction = new VersionedTransaction(messageV0);
  transaction.sign([signer.payer, ...innerTransaction.signers]);
  const signature = await connection.sendRawTransaction(
    transaction.serialize(),
    {
      maxRetries: 20,
      preflightCommitment: commitment,
    },
  );
  return signature;
}

export async function calculateAmountOut(connection: Connection, amountIn: TokenAmount, tokenOut: Token, poolKeys: LiquidityPoolKeysV4) {
  const poolInfo = await Liquidity.fetchInfo({ connection: connection, poolKeys })
  const slippage = new Percent(1000, 100); // 1000% slippage

  const { amountOut, minAmountOut, currentPrice, executionPrice, priceImpact, fee } = Liquidity.computeAmountOut({
    poolKeys,
    poolInfo,
    amountIn,
    currencyOut: tokenOut,
    slippage,
  })

  return {
    amountIn,
    amountOut,
    minAmountOut,
    currentPrice,
    executionPrice,
    priceImpact,
    fee,
  }
}

export async function calcProfit(
  spent: number,
  connection: Connection,
  amountIn: TokenAmount,
  tokenOut: Token,
  poolKeys: LiquidityPoolKeysV4): Promise<{ currentAmountOut: number, profit: number } | null> {
  try {
    const {
      amountOut,
      minAmountOut,
      currentPrice,
      executionPrice,
      priceImpact,
      fee,
    } = await calculateAmountOut(connection, amountIn, tokenOut, poolKeys)
    console.log(chalk.yellow('Calculated sell prices'));
    console.log(`${chalk.bold('current price: ')}: ${currentPrice.toFixed()}`);
    if (executionPrice !== null) {
      console.log(`${chalk.bold('execution price: ')}: ${executionPrice.toFixed()}`);
    }
    console.log(`${chalk.bold('price impact: ')}: ${priceImpact.toFixed()}`);
    console.log(`${chalk.bold('amount out: ')}: ${amountOut.toFixed()}`);
    console.log(`${chalk.bold('min amount out: ')}: ${minAmountOut.toFixed()}`);

    const amountOutInSOL = lamportsToSOLNumber(amountOut.raw);
    if (amountOutInSOL === undefined) {
      return null;
    }
    const potentialProfit = (amountOutInSOL - spent) / spent;

    return { currentAmountOut: amountOutInSOL, profit: potentialProfit };
  } catch (e) {
    console.log(chalk.yellow('Faiiled to calculate amountOut and profit.'));
    return null;
  }
}

async function loopAndWaitForProfit(
  spentAmount: number,
  targetProfitPercentage: number,
  connection: Connection,
  amountIn: TokenAmount,
  tokenOut: Token,
  poolKeys: LiquidityPoolKeysV4,
  cancellationToken: { cancelled: boolean }
) {
  let profitToTakeOrLose: number = 0;
  let prevAmountOut: number = 0;
  let priceDownCounter = 10;
  while (priceDownCounter > 0 && profitToTakeOrLose < targetProfitPercentage) {
    if (cancellationToken.cancelled) {
      break;
    }
    try {
      const calculationResult = await calcProfit(spentAmount, connection, amountIn, tokenOut, poolKeys);
      if (calculationResult !== null) {
        const { currentAmountOut, profit } = calculationResult;
        profitToTakeOrLose = profit;

        console.log(chalk.bgCyan(`Profit is less target: ${profitToTakeOrLose < targetProfitPercentage}`));

        if (currentAmountOut < prevAmountOut) {
          console.log(chalk.bgRed(`Price is DOWN`));
          priceDownCounter -= 1;
        } else {
          console.log(chalk.bgGreen(`Price is UP`));
          if (priceDownCounter < 10) { priceDownCounter += 1; }
        }

        prevAmountOut = currentAmountOut;
      }
      console.log(chalk.bold(`Profit to take: ${profitToTakeOrLose}. PriceDownCounter: ${priceDownCounter}`));
      await delay(300);
    } catch (e) {
      console.log(`${chalk.red(`Failed to profit with error: ${e}`)}`);
      await delay(300);
    }
  }

  return profitToTakeOrLose;
}

export async function waitForProfitOrTimeout(
  spentAmount: number,
  targetProfitPercentage: number,
  connection: Connection,
  amountIn: TokenAmount,
  tokenOut: Token,
  poolKeys: LiquidityPoolKeysV4) {
  let lastProfitToTake: number = 0;
  const cancellationToken = { cancelled: false }
  try {
    lastProfitToTake = await Promise.race([
      loopAndWaitForProfit(spentAmount, targetProfitPercentage, connection, amountIn, tokenOut, poolKeys, cancellationToken),
      timeout(40 * 1000, cancellationToken) // 40 seconds
    ]);
  } catch (e) {
    console.log(`Timeout happened ${chalk.bold('Profit to take: ')} ${lastProfitToTake < 0 ? chalk.red(lastProfitToTake) : chalk.green(lastProfitToTake)}`);
  }
  console.log(`Fixing profit ${chalk.bold('Profit to take: ')} ${lastProfitToTake < 0 ? chalk.red(lastProfitToTake) : chalk.green(lastProfitToTake)}`);
}