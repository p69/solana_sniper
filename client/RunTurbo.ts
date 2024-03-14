import { config } from './Config'
import { Connection } from '@solana/web3.js'
import { TurboBot } from './TurboBot'

const connection = new Connection(config.rpcHttpURL, {
  wsEndpoint: config.rpcWsURL
})

const bot = new TurboBot(connection)

async function main() {
  console.log('Run Turbo Bot')
  await bot.start(false)
  console.log('Trading complete')
}

main().catch(console.error)