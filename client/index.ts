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

// Start the server
app.listen(config.appPort, () => {
  console.log(`Server running on http://localhost:${config.appPort}`);
})