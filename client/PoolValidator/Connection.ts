import { Connection } from '@solana/web3.js'

export const connection = new Connection(process.env.RPC_URL!, {
  wsEndpoint: process.env.WS_URL!
});