import { DiscordBot } from './DiscordBot'
import * as dotenv from 'dotenv'

dotenv.config()

const bot = DiscordBot.getInstance()

bot.connect()
