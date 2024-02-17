import { Connection } from '@solana/web3.js'
import { config } from '../Config';

export const connection = new Connection(config.rpcHttpURL, {
  wsEndpoint: config.rpcWsURL
});