import { TOKEN_PROGRAM_ID, TokenAccount, SPL_ACCOUNT_LAYOUT } from '@raydium-io/raydium-sdk';
import { Connection, PublicKey, SignatureResult, Commitment, TokenBalance } from '@solana/web3.js'
import splToken from '@solana/spl-token';
import chalk from 'chalk';

export function printTime(date: Date) {
  const formatted = formatDate(date);
  console.log(formatted);
}

export function formatDate(date: Date): string {
  const hours = date.getHours().toString().padStart(2, '0');
  const minutes = date.getMinutes().toString().padStart(2, '0');
  const seconds = date.getSeconds().toString().padStart(2, '0');
  const milliseconds = date.getMilliseconds().toString().padStart(3, '0');
  const formattedTime = `${hours}:${minutes}:${seconds}.${milliseconds}`;
  return formattedTime;
}

export function timeout(ms: number): Promise<never> {
  return new Promise((_, reject) => {
    setTimeout(() => {
      reject(new Error(`Timed out after ${ms}ms`));
    }, ms);
  });
}

export async function findTokenAccountAddress(connection: Connection, tokenMintAddress: PublicKey, owner: PublicKey): Promise<PublicKey | null> {
  const tokenAccountsByOwner = await connection.getParsedTokenAccountsByOwner(
    owner,
    { programId: TOKEN_PROGRAM_ID }
  );

  const myTokenAccount = tokenAccountsByOwner.value.find(account => account.account.data.parsed.info.mint === tokenMintAddress.toString());
  if (myTokenAccount) {
    console.log('Your token account address:', myTokenAccount.pubkey.toString());
    return myTokenAccount.pubkey;
  } else {
    console.log('Token account not found for this mint address and wallet.');
    return null;
  }
}

async function getTransactionConfirmation(connection: Connection, txid: string): Promise<SignatureResult> {
  const confirmResult = await connection.confirmTransaction({ signature: txid, ...(await connection.getLatestBlockhash()) });
  return confirmResult.value;
}

export async function confirmTransaction(connection: Connection, txid: string): Promise<boolean> {
  try {
    const confirmResult = await Promise.race([
      getTransactionConfirmation(connection, txid),
      timeout(15 * 1000)
    ])
    const transactionFailed = confirmResult.err !== null;
    if (transactionFailed) {
      console.log(`Buying transaction ${chalk.bold(txid)} ${chalk.red('FAILED')}. Error: ${chalk.redBright(confirmResult.err)}`);
      return false;
    }
    return true;
  } catch (e) {
    console.log(`Buying transaction ${chalk.bold(txid)} ${chalk.red('FAILED')}. Error: ${chalk.redBright(e)}`);
    return false;
  }
}

export async function getTokenAccounts(
  connection: Connection,
  owner: PublicKey,
  commitment?: Commitment,
) {

  const tokenResp = await connection.getTokenAccountsByOwner(
    owner,
    {
      programId: TOKEN_PROGRAM_ID,
    },
    commitment,
  );

  const accounts: TokenAccount[] = [];
  for (const { pubkey, account } of tokenResp.value) {
    accounts.push({
      pubkey,
      programId: account.owner,
      accountInfo: SPL_ACCOUNT_LAYOUT.decode(account.data),
    });
  }

  return accounts;
}

export async function getNewTokenBalance(connection: Connection, hash: string, tokenAddress: string, ownerAddress: string): Promise<TokenBalance | undefined> {
  let tr = await connection.getTransaction(hash, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' });
  if (tr === null) {
    const _ = await connection.getLatestBlockhash('confirmed');
    tr = await connection.getTransaction(hash, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' });
  }
  const postTokenBalances = tr?.meta?.postTokenBalances;
  if (postTokenBalances === null || postTokenBalances === undefined) {
    return undefined;
  }
  const tokenBalance = postTokenBalances.find((x) => x.mint === tokenAddress && x.owner === ownerAddress);
  return tokenBalance;
}

export async function makeTokenAccount() {
  //splToken.createAssociatedTokenAccountIdempotent
}