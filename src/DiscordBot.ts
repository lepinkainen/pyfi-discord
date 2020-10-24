import { Client, Message } from 'discord.js';

export class DiscordBot {
    private static instance: DiscordBot;

    private client: Client = new Client();

    private constructor() {
        this.initializeClient();
    }

    static getInstance(): DiscordBot {
        if (!DiscordBot.instance) {
            DiscordBot.instance = new DiscordBot();
        }
        return DiscordBot.instance;
    }

    connect(): void {
        this.client
            .login(process.env.DISCORD_KEY)
            .then(_ => console.log('Connected to Discord'))
            .catch(error =>
                console.error(`Could not connect. Error: ${error.message}`)
            );
    }

    private initializeClient(): void {
        if (!this.client) return;

        this.setReadyHandler();
        this.setMessageHandler();
    }

    private setReadyHandler(): void {
        this.client.on('ready', () => {
            console.log(`Logged in as ${this.client.user?.tag}!`);
        });
    };

    private setMessageHandler(): void {
        this.client.on('message', async (message: Message) => {
            //* filters out requests from bots
            if (message.author.bot) return;

            const prefix = process.env.PREFIX ?? "."

            // Not our prefix, we don't care
            if (!message.content.startsWith(prefix)) return;

            console.debug("Command message: " + JSON.stringify(message.toJSON()));

            const args = message.content.slice(prefix.length).trim().split(' ');
            const command = args.shift()?.toLowerCase();

            if (command === 'ping') {
                await message.reply('Pong! (' + args + ')');
                return;
            }

            console.debug("ERROR: Unknown command: " + JSON.stringify(message.toJSON()));
        });
    };
}
