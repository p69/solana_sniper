import * as dotenv from 'dotenv';
dotenv.config();
import { Connection, PublicKey, Keypair } from '@solana/web3.js'
import { confirmTransaction, findTokenAccountAddress, getTokenAccounts, getNewTokenBalance } from './Utils';
import { TokenAmount, Token, Percent, jsonInfo2PoolKeys, LiquidityPoolKeys, WSOL } from "@raydium-io/raydium-sdk";
import { TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { Wallet } from '@project-serum/anchor'
import base58 from 'bs58'
import { swapOnlyCLMM } from "./CllmSwap"
import { DEFAULT_TOKEN } from './RaydiumConfig';
import { getWalletTokenAccount } from './RaydiumUtils';
import { swapOnlyAmm } from './RaydiumAMM/AmmSwap'
import chalk from 'chalk';
import { formatAmmKeysById } from './RaydiumAMM/formatAmmKeysById';
import { sellTokens } from './Swap';
import RaydiumSwap from './RaydiumSwap';

const wallet = new Wallet(Keypair.fromSecretKey(base58.decode(process.env.WALLET_PRIVATE_KEY!)));
const SOL = 'So11111111111111111111111111111111111111112';
const SOL_KEY = new PublicKey(SOL);
const JUP = 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN';
const JUP_MARKET_ID = '7WMCUyZXrDxNjAWjuh2r7g8CdT2guqvrmdUPAnGdLsfG';
const SHIT = '8dHTQvSJEYro4C3BN3o4dfdBH1YBduHUzuY2NLzpFafL';
const SHIT_POOL_ID = '2k8taNR2pLfp84HCxgBE33t87xZ7iVmdQtvXtsqCi9BH';
const BUY_AMOUNT_IN_SOL = 0.01 // e.g. 0.01 SOL -> B_TOKEN

// const [SOL_SPL_TOKEN_ADDRESS] = PublicKey.findProgramAddressSync(
//   [OWNER_ADDRESS.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), NATIVE_MINT.toBuffer()],
//   ASSOCIATED_TOKEN_PROGRAM_ID
// );



const connection = new Connection(process.env.RPC_URL!, {
  wsEndpoint: process.env.WS_URL!, commitment: 'confirmed'
});

const raydiumSwap = new RaydiumSwap(connection, process.env.WALLET_PRIVATE_KEY!);

async function runSwapTest() {
  //const tokenAccounts = await getTokenAccounts(connection, wallet.publicKey);


  console.log('Startttt')
  const targetPoolInfo = await formatAmmKeysById(connection, SHIT_POOL_ID);
  const poolKeys = jsonInfo2PoolKeys(targetPoolInfo) as LiquidityPoolKeys

  const tokenToSnipe = new Token(TOKEN_PROGRAM_ID, new PublicKey(SHIT), 8)
  const quoteToken = DEFAULT_TOKEN.WSOL;
  const quoteTokenAmount = new TokenAmount(quoteToken, 0.01, false)
  const buySlippage = new Percent(10, 100)
  const sellSlippage = new Percent(20, 100)
  const allWalletTokenAccounts = await getWalletTokenAccount(connection, wallet.publicKey)
  const wsolAccount = allWalletTokenAccounts.find(
    (acc) => acc.accountInfo.mint.toString() === SOL,
  )!;

  const startWsolBalance = await connection.getTokenAccountBalance(wsolAccount.pubkey)

  const [buyTxid] = (await swapOnlyAmm(connection, wallet.payer, {
    outputToken: tokenToSnipe,
    targetPool: SHIT_POOL_ID,
    inputTokenAmount: quoteTokenAmount,
    slippage: buySlippage,
    walletTokenAccounts: allWalletTokenAccounts,
    wallet: wallet.payer,
  })).txids;

  console.log(`BUY tx https://solscan.io/tx/${buyTxid}`);

  console.log(`${chalk.yellow('Confirming...')}`);
  // const _ = await connection.getLatestBlockhash({
  //   commitment: 'confirmed',
  // });
  const transactionConfirmed = await confirmTransaction(connection, buyTxid);
  if (transactionConfirmed) {
    console.log(`${chalk.green('Confirmed')}`);
  } else {
    console.log(`${chalk.red('Failed :(')}`);
    return;
  }

  // const shitCoinAcc = await findTokenAccountAddress(connection, tokenToSnipe.mint, wallet.publicKey);
  const shitCoinAcc = allWalletTokenAccounts.find(
    (acc) => acc.accountInfo.mint.toString() === SHIT,
  )!;
  if (shitCoinAcc === null) {
    console.error("Failed to fetch token balance after transaction");
    return;
  }
  //const shitCoinBalance = (await connection.getTokenAccountBalance(shitCoinAcc.pubkey)).value
  const shitCoinBalance = await getNewTokenBalance(connection, buyTxid, SHIT, wallet.publicKey.toString());
  if (shitCoinBalance === undefined) {
    console.log(`${chalk.red("Couldn't fetch new balance :((")}`)
    return;
  }
  console.log(`Baught ${shitCoinBalance.uiTokenAmount.uiAmount} tokens`);
  console.log('Selling')

  const updatedWalletTokenAccounts = await getWalletTokenAccount(connection, wallet.publicKey)

  const sellTokenAmount = new TokenAmount(tokenToSnipe, shitCoinBalance.uiTokenAmount.uiAmount ?? 0, false)

  // const sellTxid = await sellTokens(connection, poolKeys, wsolAccount, shitCoinAcc, wallet, sellTokenAmount);

  let [sellTxid] = (await swapOnlyAmm(connection, wallet.payer, {
    outputToken: quoteToken,
    targetPool: SHIT_POOL_ID,
    inputTokenAmount: sellTokenAmount,
    slippage: sellSlippage,
    walletTokenAccounts: updatedWalletTokenAccounts,
    wallet: wallet.payer,
  })).txids;

  console.log(`SELL tx https://solscan.io/tx/${sellTxid}`);

  console.log(`${chalk.yellow('Confirming...')}`);
  const sellConfirmed = await confirmTransaction(connection, sellTxid);
  if (sellConfirmed) {
    console.log(`${chalk.green('Confirmed')}`);
  } else {
    console.log(`${chalk.red('Failed :( retry sell')}`);
    const updatedWalletTokenAccounts = await getWalletTokenAccount(connection, wallet.publicKey)

    const sellTokenAmount = new TokenAmount(tokenToSnipe, shitCoinBalance.uiTokenAmount.uiAmount ?? 0, false)

    // const sellTxid = await sellTokens(connection, poolKeys, wsolAccount, shitCoinAcc, wallet, sellTokenAmount);

    const [sellRetryTxid] = (await swapOnlyAmm(connection, wallet.payer, {
      outputToken: quoteToken,
      targetPool: SHIT_POOL_ID,
      inputTokenAmount: sellTokenAmount,
      slippage: sellSlippage,
      walletTokenAccounts: updatedWalletTokenAccounts,
      wallet: wallet.payer,
    })).txids;

    sellTxid = sellRetryTxid
  }

  console.log(`${chalk.yellow('Confirming...')}`);
  const sellRetryConfirmed = await confirmTransaction(connection, sellTxid);
  if (sellRetryConfirmed) {
    console.log(`${chalk.green('Confirmed')}`);
  } else {
    console.log(`${chalk.red('Failed :( retry sell')}`);
  }

  const finalWsolBalance = await getNewTokenBalance(connection, sellTxid, WSOL.mint, wallet.publicKey.toString());
  const startNumber = startWsolBalance.value.uiAmount ?? 0;
  const endNumber = finalWsolBalance?.uiTokenAmount.uiAmount ?? 0;
  const shotProfit = (endNumber - startNumber) / 0.01;
  const profitInPercent = shotProfit * 100;
  const formatted = Number(profitInPercent.toPrecision(3));
  const finalProfitString = formatted.toFixed(1) + '%';

  console.log(`Start WSOL: ${startNumber}`);
  console.log(`End WSOL: ${endNumber}`);
  console.log(`Shot profit: ${shotProfit > 0 ? chalk.green(finalProfitString) : chalk.red(finalProfitString)}`);
}

runSwapTest();