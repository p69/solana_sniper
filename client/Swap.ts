import { Liquidity, LiquidityPoolKeysV4, TokenAccount, TokenAmount } from "@raydium-io/raydium-sdk";
import { Connection, PublicKey, Commitment, TransactionMessage, ComputeBudgetProgram, VersionedTransaction } from "@solana/web3.js";
import {
  createAssociatedTokenAccountIdempotentInstruction
} from '@solana/spl-token';
import { Wallet } from '@project-serum/anchor'

export async function swapTokens(
  connection: Connection,
  poolKeys: LiquidityPoolKeysV4,
  quoteTokenAccount: TokenAccount,
  baseTokenAddess: PublicKey,
  signer: Wallet,
  quoteAmount: TokenAmount,
  commitment: Commitment = 'confirmed'
): Promise<string> {
  const { innerTransaction, address } = Liquidity.makeSwapFixedInInstruction(
    {
      poolKeys: poolKeys,
      userKeys: {
        tokenAccountIn: quoteTokenAccount.pubkey,
        tokenAccountOut: baseTokenAddess,
        owner: signer.publicKey,
      },
      amountIn: quoteAmount.raw,
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
        baseTokenAddess,
        signer.publicKey,
        poolKeys.baseMint,
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