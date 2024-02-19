import express, { Request, Response } from 'express'
import { config } from './Config'
import { connection } from './PoolValidator/Connection'
import { TradingBot } from './Bot'


const app = express()

// Internal state
const bot = new TradingBot(connection)

// Single endpoint that increments and displays the visit count
app.get('/start', (req: Request, res: Response) => {
  if (bot.isStarted()) {
    res.send('Is already started')
  } else {
    bot.start()
    res.send(`Bot is started to handle new pools`);
  }
})

app.get('/wallet', (req: Request, res: Response) => {
  if (bot.isStarted()) {
    res.send(`Bot is started. Current wallet:\n${JSON.stringify(bot.getWalletTradingInfo())}`)
  } else {
    res.send(`Bot is not started. Current wallet:\n${JSON.stringify(bot.getWalletTradingInfo())}`)
  }
})

app.get('/skipped', (req: Request, res: Response) => {
  res.send(JSON.stringify(bot.getSkippedPools()))
})

app.get('/trades', (req: Request, res: Response) => {
  res.send(JSON.stringify(bot.getTradingResults()))
})

// Start the server
app.listen(config.appPort, () => {
  console.log(`Server running on http://localhost:${config.appPort}`);
})