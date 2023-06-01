import { Client, Message, GatewayIntentBits } from "discord.js";
import axios from "axios";

export class DiscordBot {
  private static instance: DiscordBot;

  private client: Client = new Client({
    intents: [GatewayIntentBits.GuildMessages],
  });

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
      .then((result) => console.log("Connected to Discord: " + result))
      .catch((error) =>
        console.error(`Could not connect. Error: ${error.message}`)
      );
  }

  private initializeClient(): void {
    if (!this.client) return;

    this.setReadyHandler();
    this.setMessageHandler();
  }

  private setReadyHandler(): void {
    this.client.on("ready", () => {
      console.log(`Logged in as ${this.client.user?.tag}!`);
    });
  }

  /**
   * Calls external API hosted in AWS Lambda to resolve commands
   *
   * @param message discord.js message object
   * @param command command
   * @param args arguments to command
   */
  private async pyfiCommand(
    message: Message,
    command: string,
    args: string[]
  ): Promise<boolean> {
    console.debug(
      "External command '" + command + "' called with arguments: '" + args + "'"
    );

    const lambdafunc = process.env.LAMBDA_URL ?? "";
    const headers = { "x-api-key": process.env.LAMBDA_APIKEY ?? "" };

    const res = await axios.post(
      lambdafunc,
      {
        command: command,
        args: args.join(" "),
        //'source': message.channel?.name,
        user: message.author.username,
      },
      {
        headers: headers,
      }
    );

    console.debug(res);

    // The API will always return 200, but errorType and errorMessage
    // will be populated if there is an error
    if (res.status === 200 && res.data.errorType === undefined) {
      const apiresult = res.data.result as string;
      if (apiresult.startsWith("Unknown command:")) return false;

      console.debug("Got reply from external command");
      // just in case, discord.js will hard exit if reply content is undefined
      if (res.data.result !== undefined && res.data.result !== "") {
        message.reply(res.data.result);
      } else {
        console.warn("Invalid command called on backend: ", command);
      }

      return true;
    }

    console.info("No external command matched, returning to main flow");
    return false;
  }

  /**
   * Set the on message handler in discord.js
   */
  private setMessageHandler(): void {
    this.client.on("message", async (message: Message) => {
      //* filters out requests from bots
      if (message.author.bot) return;

      const prefix = process.env.PREFIX ?? ".";

      // Not our prefix, we don't care
      if (!message.content.startsWith(prefix)) return;

      console.debug("Command message: " + JSON.stringify(message.toJSON()));

      const args = message.content.slice(prefix.length).trim().split(" ");
      const command = args.shift()?.toLowerCase();

      // Check external command service first, if it matches, we stop processing
      if (
        command !== undefined &&
        (await this.pyfiCommand(message, command, args))
      ) {
        console.debug("External handler matched, abort further handling");
        return;
      }

      if (command === "ping") {
        await message.reply("Pong! (" + args + ")");
        return;
      }

      console.debug(
        "ERROR: Unknown command: " + JSON.stringify(message.toJSON())
      );
    });
  }
}
