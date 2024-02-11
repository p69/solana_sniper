import * as dotenv from 'dotenv';
dotenv.config();
import { Connection, PublicKey, Keypair } from '@solana/web3.js'
import { confirmTransaction, formatDate, getNewTokenBalance, getTokenAccounts } from './Utils';
import { runNewPoolObservation, setPoolProcessed, PoolWithStrategy } from './RaydiumNewPool'
import { ASSOCIATED_TOKEN_PROGRAM_ID, LiquidityPoolKeys, LiquidityPoolKeysV4, SOL, Token, TokenAccount, TokenAmount, WSOL } from "@raydium-io/raydium-sdk";
import chalk from 'chalk';
import { NATIVE_MINT, TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from '@solana/spl-token';
import { Wallet } from '@project-serum/anchor'
import base58 from 'bs58'
import { GeneralTokenCondition, swapTokens, validateTradingTrendOrTimeout, waitForProfitOrTimeout } from './Swap';
import RaydiumSwap from './RaydiumSwap';
//import { startObserving } from "./ObserveOpenBooks";

const OWNER_ADDRESS = new PublicKey(process.env.WALLET_PUBLIC_KEY!);
const BUY_AMOUNT_IN_SOL = 0.3
const BUYING_CONDITIONS_SET: Set<GeneralTokenCondition> = new Set(['PUMPING', 'NOT_PUMPING_BUT_GROWING', 'NOT_DUMPING_BUT_DIPPING']);
const WSOL_TOKEN = new Token(TOKEN_PROGRAM_ID, WSOL.mint, WSOL.decimals)
const [SOL_SPL_TOKEN_ADDRESS] = PublicKey.findProgramAddressSync(
  [OWNER_ADDRESS.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), NATIVE_MINT.toBuffer()],
  ASSOCIATED_TOKEN_PROGRAM_ID
);

const connection = new Connection(process.env.RPC_URL!, {
  wsEndpoint: process.env.WS_URL!, commitment: 'confirmed'
});

const wallet = new Wallet(Keypair.fromSecretKey(base58.decode(process.env.WALLET_PRIVATE_KEY!)));

async function buyShitcoin(
  shitcoinToken: Token,
  shitcoinAccountAddress: PublicKey,
  poolInfo: LiquidityPoolKeysV4,
  mainTokenAccountAddress: PublicKey): Promise<number | null> {

  const swapStartDate = new Date();

  const buyAmount = new TokenAmount(WSOL_TOKEN, BUY_AMOUNT_IN_SOL, false)

  console.log(chalk.yellow(`Getting trend before buying a token`));
  const trendCondition = await validateTradingTrendOrTimeout(connection, buyAmount, shitcoinToken, poolInfo);
  if (trendCondition === null) {
    console.log('STOP BUYING');
    return null;
  }

  console.log(`${chalk.yellow('Token trend: ')}${chalk.cyan(`${trendCondition}`)}`);
  if (!BUYING_CONDITIONS_SET.has(trendCondition)) {
    console.log(chalk.red(`${trendCondition}`) + 'is not allowed for trading. STOPPING');
    return null;
  }

  console.log(`Buying ${shitcoinToken.mint} for ${BUY_AMOUNT_IN_SOL} SOL`);

  let txid = '';
  try {
    txid = await swapTokens(
      connection,
      poolInfo,
      mainTokenAccountAddress,
      shitcoinAccountAddress,
      wallet,
      buyAmount
    );
  } catch (e) {
    console.log(chalk.red(`Failed to buy shitcoin with error ${e}. Retrying.`));
    txid = await swapTokens(
      connection,
      poolInfo,
      mainTokenAccountAddress,
      shitcoinAccountAddress,
      wallet,
      buyAmount
    );
  }

  if (txid === '') {
    return null;
  }

  const swapEndDate = new Date();

  console.log(`${chalk.yellow(`Confirming buying transaction. https://solscan.io/tx/${txid}`)}`);

  const transactionConfirmed = await confirmTransaction(connection, txid);
  if (!transactionConfirmed) {
    return null;
  }

  console.log(`Buying transaction ${chalk.green('CONFIRMED')}. https://solscan.io/tx/${txid}`);

  console.log(`Buying finished. Started at ${formatDate(swapStartDate)}, finished at ${formatDate(swapEndDate)}`);
  console.log(`Getting bought tokens amount`);

  const shitTokenBalance = await getNewTokenBalance(connection, txid, shitcoinToken.mint.toString(), wallet.publicKey.toString());
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
  poolWithStrategy: PoolWithStrategy): Promise<number> {

  console.log(`Selling ${amountToSell} shitcoins`);

  console.log(`Calculating amountOut to sell with profit ${poolWithStrategy.targetProfit * 100}%`);

  const poolInfo = poolWithStrategy.pool

  await waitForProfitOrTimeout(
    BUY_AMOUNT_IN_SOL,
    poolWithStrategy.targetProfit,
    connection,
    amountToSell,
    WSOL_TOKEN,
    poolInfo,
    poolWithStrategy.exitTimeoutInMillis);

  const swapStartDate = new Date();

  let txid: string = '';
  try {
    txid = await swapTokens(
      connection,
      poolInfo,
      shitcoinAccountAddress,
      mainTokenAccountAddress,
      wallet,
      amountToSell
    );
  } catch (e) {
    console.log(`${chalk.red(`Failed to sell with error ${e}`)}`);
    console.log('Retrying');
    try {
      txid = await swapTokens(
        connection,
        poolInfo,
        shitcoinAccountAddress,
        mainTokenAccountAddress,
        wallet,
        amountToSell
      );
    } catch (e2) {
      console.log(`${chalk.red(`Failed to sell with error ${e}`)}`);
      return -1;
    }
  }


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

  await updateWSOLBalance();

  return latestWSOLBalance;
}

const swap = async (
  tokenB: Token,
  poolWithStrategy: PoolWithStrategy,
  mainTokenAccount: PublicKey) => {
  const tokenBAccountAddress = getAssociatedTokenAddressSync(tokenB.mint, wallet.publicKey, false);
  const originalBalanceValue = latestWSOLBalance;

  const swappedShitcoinsAmount = await buyShitcoin(tokenB, tokenBAccountAddress, poolWithStrategy.pool, mainTokenAccount);
  if (swappedShitcoinsAmount === null) {
    console.log(`${chalk.red('Failed')} to BUY shiitcoins. STOP sniping`);
    return;
  } else {
    console.log(`${chalk.yellow(`Got ${swappedShitcoinsAmount} tokens. Selling`)}`);
  }
  const amountToSell = new TokenAmount(tokenB, swappedShitcoinsAmount, false);
  const afterSellSOLBalance = await sellShitcoin(amountToSell, mainTokenAccount, tokenBAccountAddress, poolWithStrategy);
  const finalSOLBalance = afterSellSOLBalance < 0 ? (originalBalanceValue - BUY_AMOUNT_IN_SOL) : afterSellSOLBalance;
  const profit = (finalSOLBalance - originalBalanceValue) / BUY_AMOUNT_IN_SOL;
  const profitInPercent = profit * 100;
  const formatted = Number(profitInPercent.toPrecision(3));
  const finalProfitString = formatted.toFixed(1) + '%';
  console.log(`${chalk.bold("Profit: ")}: ${profit < 0 ? chalk.red(finalProfitString) : chalk.green(finalProfitString)}`);
}

let latestWSOLBalance: number = 0;

async function updateWSOLBalance() {
  const result = await connection.getTokenAccountBalance(SOL_SPL_TOKEN_ADDRESS);
  latestWSOLBalance = result.value.uiAmount ?? 0;
}

async function testWithExistingPool() {
  const POOL_ID = '4doQnCB4ppx2oPfewcYrp63i7fvRN5bWb9x1XZwt6j3S';
  const SHIT_COIN_ADDRESS = '8w63or5Dfjb24TYmzXnY3VHPsczA1pUT7SzDW3JFe6Uz';

  const raydiumSwap = new RaydiumSwap(connection, process.env.WALLET_PRIVATE_KEY!);
  await raydiumSwap.loadPoolKeys();
  const pool = raydiumSwap.findPoolInfoForTokens(WSOL.mint, SHIT_COIN_ADDRESS);
  if (pool !== null) {
    handleNewPool({
      pool,
      targetProfit: 0.5,
      exitTimeoutInMillis: 1 * 60 * 1000
    });
  }
}

async function handleNewPool(poolWithStrategy: PoolWithStrategy) {
  if (isSwapping) {
    return;
  }

  const pool = poolWithStrategy.pool

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
  try {
    await swap(tokenBToken, poolWithStrategy, SOL_SPL_TOKEN_ADDRESS);
  } catch (e) {
    console.log(`${chalk.red(`Swapping failed with error: ${e}`)}`)
  }

  isSwapping = false;
  console.log("End swapping");
}

let isSwapping = false;
async function main() {
  await updateWSOLBalance();

  /* Uncomment to perform single buy/sell test with predifined pool */
  // await testWithExistingPool();
  // return;
  /* Uncomment to perform single buy/sell test with predifined pool */


  runNewPoolObservation(async (pool: PoolWithStrategy) => {
    await handleNewPool(pool);
    setPoolProcessed();
  });
};

main().catch(console.error);