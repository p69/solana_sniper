import * as dotenv from 'dotenv';
dotenv.config();
import { Connection, PublicKey, Keypair } from '@solana/web3.js'
import { confirmTransaction, formatDate, getNewTokenBalance, getTokenAccounts } from './Utils';
import { runNewPoolObservation } from './RaydiumNewPool'
import { ASSOCIATED_TOKEN_PROGRAM_ID, LiquidityPoolKeys, LiquidityPoolKeysV4, SOL, Token, TokenAccount, TokenAmount, WSOL } from "@raydium-io/raydium-sdk";
import chalk from 'chalk';
import { NATIVE_MINT, TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from '@solana/spl-token';
import { Wallet } from '@project-serum/anchor'
import base58 from 'bs58'
import { swapTokens } from './Swap';
import RaydiumSwap from './RaydiumSwap';
//import { startObserving } from "./ObserveOpenBooks";

const OWNER_ADDRESS = new PublicKey(process.env.WALLET_PUBLIC_KEY!);
const BUY_AMOUNT_IN_SOL = 0.01
const [SOL_SPL_TOKEN_ADDRESS] = PublicKey.findProgramAddressSync(
  [OWNER_ADDRESS.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), NATIVE_MINT.toBuffer()],
  ASSOCIATED_TOKEN_PROGRAM_ID
);

const connection = new Connection(process.env.RPC_URL!, {
  wsEndpoint: process.env.WS_URL!, commitment: 'confirmed'
});

const wallet = new Wallet(Keypair.fromSecretKey(base58.decode(process.env.WALLET_PRIVATE_KEY!)));

async function buyShitcoin(
  shitcoinAddress: PublicKey,
  shitcoinAccountAddress: PublicKey,
  poolInfo: LiquidityPoolKeysV4,
  mainTokenAccountAddress: PublicKey): Promise<number | null> {
  console.log(`Buying ${shitcoinAddress} for ${BUY_AMOUNT_IN_SOL} SOL`);
  const swapStartDate = new Date();

  const buyAmount = new TokenAmount(new Token(TOKEN_PROGRAM_ID, WSOL.mint, WSOL.decimals), BUY_AMOUNT_IN_SOL, false)
  const txid = await swapTokens(
    connection,
    poolInfo,
    mainTokenAccountAddress,
    shitcoinAccountAddress,
    wallet,
    buyAmount
  );
  const swapEndDate = new Date();

  console.log(`${chalk.yellow(`Confirming buying transaction. https://solscan.io/tx/${txid}`)}`);

  const transactionConfirmed = await confirmTransaction(connection, txid);
  if (!transactionConfirmed) {
    return null;
  }

  console.log(`Buying transaction ${chalk.green('CONFIRMED')}. https://solscan.io/tx/${txid}`);

  console.log(`Buying finished. Started at ${formatDate(swapStartDate)}, finished at ${formatDate(swapEndDate)}`);
  console.log(`Getting bought tokens amount`);

  const shitTokenBalance = await getNewTokenBalance(connection, txid, shitcoinAddress.toString(), wallet.publicKey.toString());
  let snipedAmount: number | null
  if (shitTokenBalance !== undefined) {
    snipedAmount = shitTokenBalance.uiTokenAmount.uiAmount;
  } else {
    console.log(`${chalk.red("Couldn't fetch new balance. Trying to fetch account with balance")}`)
    const balance = (await connection.getTokenAccountBalance(shitcoinAccountAddress)).value

    snipedAmount = balance.uiAmount
  }

  return snipedAmount;
}

//Sell shitcoins and return amount of SOL in wallet
async function sellShitcoin(
  amountToSell: TokenAmount,
  mainTokenAccountAddress: PublicKey,
  shitcoinAccountAddress: PublicKey,
  poolInfo: LiquidityPoolKeysV4): Promise<number> {
  console.log(`Selling ${amountToSell} shitcoins`);
  const swapStartDate = new Date();

  //const sellTokenAmount = new TokenAmount(new Token(TOKEN_PROGRAM_ID, shitcoinAddress.toString(), WSOL.decimals), amountToSell, false);

  // const sellTxid = await sellTokens(connection, poolKeys, wsolAccount, shitCoinAcc, wallet, sellTokenAmount);

  let txid = await swapTokens(
    connection,
    poolInfo,
    shitcoinAccountAddress,
    mainTokenAccountAddress,
    wallet,
    amountToSell
  );

  const swapEndDate = new Date();

  console.log(`${chalk.yellow(`Confirming selliing transaction. https://solscan.io/tx/${txid}`)}`);

  const transactionConfirmed = await confirmTransaction(connection, txid);
  if (transactionConfirmed) {
    console.log(`${chalk.green('Confirmed')}`);
  } else {
    console.log(`${chalk.red('Failed, retry sell')}`);

    txid = await swapTokens(
      connection,
      poolInfo,
      shitcoinAccountAddress,
      mainTokenAccountAddress,
      wallet,
      amountToSell
    );

    console.log(`${chalk.yellow('Confirming...')}`);
    const sellRetryConfirmed = await confirmTransaction(connection, txid);
    if (!sellRetryConfirmed) {
      console.log(`${chalk.red(`Failed. Try to sell manually.`)}`);
      return -1;
    }
  }

  console.log(`Selling transaction ${chalk.green('CONFIRMED')}. https://solscan.io/tx/${txid}`);
  console.log(`Selling finished. Started at ${formatDate(swapStartDate)}, finished at ${formatDate(swapEndDate)}`);
  console.log(`Getting SELL transaction details https://solscan.io/tx/${txid}`);

  let finalBalance = await getWSOLBalance();

  return finalBalance;
}

const swap = async (
  tokenB: Token,
  pool: LiquidityPoolKeys,
  mainTokenAccount: PublicKey) => {
  const tokenBAccountAddress = getAssociatedTokenAddressSync(tokenB.mint, wallet.publicKey, false);
  const originalBalanceValue = await getWSOLBalance();

  const poolInfo = pool
  if (poolInfo === null) {
    console.error("No Pool Info");
    return;
  }

  const swappedShitcoinsAmount = await buyShitcoin(tokenB.mint, tokenBAccountAddress, poolInfo, mainTokenAccount);
  if (swappedShitcoinsAmount === null) {
    console.log(`${chalk.red('Failed')} to BUY shiitcoins. STOP sniping`);
    return;
  } else {
    console.log(`${chalk.yellow(`Got ${swappedShitcoinsAmount} tokens. Selling`)}`);
  }
  const amountToSell = new TokenAmount(tokenB, swappedShitcoinsAmount, false);
  const afterSellSOLBalance = await sellShitcoin(amountToSell, mainTokenAccount, tokenBAccountAddress, poolInfo);
  const finalSOLBalance = afterSellSOLBalance < 0 ? (originalBalanceValue - BUY_AMOUNT_IN_SOL) : afterSellSOLBalance;
  const profit = (finalSOLBalance - originalBalanceValue) / BUY_AMOUNT_IN_SOL;
  const profitInPercent = profit * 100;
  const formatted = Number(profitInPercent.toPrecision(3));
  const finalProfitString = formatted.toFixed(1) + '%';
  console.log(`${chalk.bold("Profit: ")}: ${profit < 0 ? chalk.red(finalProfitString) : chalk.green(finalProfitString)}`);
}

async function getWSOLBalance(): Promise<number> {
  const result = await connection.getTokenAccountBalance(SOL_SPL_TOKEN_ADDRESS);
  return result.value.uiAmount ?? 0;
}

async function testWithExistingPool() {
  const POOL_ID = '7Gs7Th8JfTYAdVPT5S35uTELd3kRCJzz67WaBi4M7LvR';
  const SHIT_COIN_ADDRESS = 'DUAXVeRMCn64PopKRX9vND9MwUjutv7z8gf4beVWk6nM';

  const raydiumSwap = new RaydiumSwap(connection, process.env.WALLET_PRIVATE_KEY!);
  await raydiumSwap.loadPoolKeys();
  const pool = raydiumSwap.findPoolInfoForTokens(WSOL.mint, SHIT_COIN_ADDRESS);
  if (pool !== null) {
    handleNewPool(pool);
  }
}

async function handleNewPool(pool: LiquidityPoolKeysV4) {
  if (isSwapping) {
    return;
  }

  console.log(`New pool ${chalk.green(pool.id.toString())}`);
  let tokenAMint = pool.baseMint.toString() === WSOL.mint ? pool.baseMint : pool.quoteMint;
  let tokenBMint = pool.baseMint.toString() !== WSOL.mint ? pool.baseMint : pool.quoteMint;
  let tokenBDecimals = pool.baseMint.toString() === tokenBMint.toString() ? pool.baseDecimals : pool.quoteDecimals;
  console.log(`Verify tokens A - ${tokenAMint.toString()}   B - ${tokenBMint.toString()}`);

  if (pool.quoteMint.toString() !== WSOL.mint && pool.baseMint.toString() !== WSOL.mint) {
    console.log(`No SOL in pair. Skip swapping.`);
    return;
  }

  isSwapping = true;
  console.log("Start swapping");
  const tokenBToken = new Token(TOKEN_PROGRAM_ID, tokenBMint, tokenBDecimals)
  await swap(tokenBToken, pool, SOL_SPL_TOKEN_ADDRESS);
  isSwapping = false;
  console.log("End swapping");
}

let isSwapping = false;
async function main() {
  /// Uncomment to perform single buy/sell test with predifined pool  
  // await testWithExistingPool();
  // return;

  runNewPoolObservation(async (pool: LiquidityPoolKeysV4) => {
    await handleNewPool(pool);
  });
};

main().catch(console.error);