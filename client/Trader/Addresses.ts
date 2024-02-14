import { ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID, Token, WSOL } from "@raydium-io/raydium-sdk";
import { Keypair, PublicKey } from "@solana/web3.js"
import { NATIVE_MINT } from "@solana/spl-token"
import { Wallet } from "@project-serum/anchor";
import base58 from "bs58";

export const OWNER_ADDRESS = new PublicKey(process.env.WALLET_PUBLIC_KEY!)
export const [SOL_SPL_TOKEN_ADDRESS] = PublicKey.findProgramAddressSync(
  [OWNER_ADDRESS.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), NATIVE_MINT.toBuffer()],
  ASSOCIATED_TOKEN_PROGRAM_ID
)
export const WSOL_TOKEN = new Token(TOKEN_PROGRAM_ID, WSOL.mint, WSOL.decimals)
export const PAYER = new Wallet(Keypair.fromSecretKey(base58.decode(process.env.WALLET_PRIVATE_KEY!)))