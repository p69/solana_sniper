import { Liquidity, LiquidityPoolKeysV4, Percent, SOL, TokenAccount, TokenAmount, WSOL } from "@raydium-io/raydium-sdk";
import { Connection, PublicKey, Commitment, TransactionMessage, ComputeBudgetProgram, VersionedTransaction } from "@solana/web3.js";
import {
  createAssociatedTokenAccountIdempotentInstruction
} from '@solana/spl-token';
import { Wallet } from '@project-serum/anchor'

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