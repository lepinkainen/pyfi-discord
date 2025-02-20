import {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  Collection,
  ApplicationCommandDataResolvable,
} from "discord.js";
import axios from "axios";

export class DiscordBot {
  private static instance: DiscordBot;
  private commands: Collection<
    string,
    (interaction: ChatInputCommandInteraction) => Promise<void>
  > = new Collection();

  private client: Client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.DirectMessages,
      GatewayIntentBits.DirectMessageReactions,
      GatewayIntentBits.DirectMessageTyping,
      GatewayIntentBits.GuildMembers,
    ],
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

  private validateEnvironment(): void {
    const required = ["DISCORD_KEY", "CLIENT_ID", "GUILD_ID"];
    const missing = required.filter((key) => !process.env[key]);

    if (missing.length > 0) {
      throw new Error(
        `Missing required environment variables: ${missing.join(", ")}`
      );
    }
  }

  async connect(): Promise<void> {
    this.validateEnvironment();
    await this.registerSlashCommands();

    this.client
      .login(process.env.DISCORD_KEY)
      .then(() => console.log("Connected to Discord"))
      .catch((error) =>
        console.error(`Could not connect. Error: ${error.message}`)
      );
  }

  private async registerSlashCommands(): Promise<void> {
    const commands: ApplicationCommandDataResolvable[] = [
      new SlashCommandBuilder()
        .setName("weather")
        .setDescription("Replies with Weather")
        .toJSON(),
      new SlashCommandBuilder()
        .setName("help")
        .setDescription("Shows all available commands")
        .toJSON(),
      // Add more slash commands here
    ];

    try {
      if (!process.env.DISCORD_KEY) {
        throw new Error("DISCORD_KEY is not defined");
      }
      if (!process.env.CLIENT_ID) {
        throw new Error("CLIENT_ID is not defined");
      }
      if (!process.env.GUILD_ID) {
        throw new Error("GUILD_ID is not defined");
      }

      const rest = new REST().setToken(process.env.DISCORD_KEY);
      console.log("Started refreshing guild (/) commands.");

      // Register commands for a specific guild instead of globally
      await rest.put(
        Routes.applicationGuildCommands(
          process.env.CLIENT_ID,
          process.env.GUILD_ID
        ),
        { body: commands }
      );

      console.log("Successfully reloaded guild (/) commands.");
    } catch (error) {
      console.error("Error registering commands:", error);
    }
  }

  private initializeClient(): void {
    if (!this.client) return;

    this.registerCommandHandlers();
    this.setReadyHandler();
    this.setInteractionHandler();
  }

  private registerCommandHandlers(): void {
    this.commands.set(
      "ping",
      async (interaction: ChatInputCommandInteraction) => {
        await interaction.reply("Pong!");
      }
    );

    this.commands.set(
      "help",
      async (interaction: ChatInputCommandInteraction) => {
        const helpMessage = [
          "**Available Commands:**",
          `/ping - Check if bot is responsive`,
          `/help - Show this help message`,
          // Add more command descriptions here
        ].join("\n");

        await interaction.reply(helpMessage);
      }
    );
  }

  private setReadyHandler(): void {
    this.client.on("ready", () => {
      console.log(`Logged in as ${this.client.user?.tag}!`);
    });
  }

  /**
   * Calls external API hosted in AWS Lambda to resolve commands
   */
  private async pyfiCommand(
    interaction: ChatInputCommandInteraction,
    command: string,
    args: string
  ): Promise<boolean> {
    try {
      console.debug(
        `External command '${command}' called with arguments: '${args}'`
      );

      const lambdafunc = process.env.LAMBDA_URL ?? "";
      const headers = { "x-api-key": process.env.LAMBDA_APIKEY ?? "" };

      const res = await axios.post(
        lambdafunc,
        {
          command: command,
          args: args,
          user: interaction.user.username,
        },
        {
          headers: headers,
          timeout: 5000,
        }
      );

      if (res.status === 200 && res.data.errorType === undefined) {
        const apiresult = res.data.result as string;
        if (apiresult.startsWith("Unknown command:")) return false;

        if (res.data.result !== undefined && res.data.result !== "") {
          await interaction.reply(res.data.result);
        } else {
          console.warn("Invalid command called on backend: ", command);
        }
        return true;
      }

      console.info("No external command matched, returning to main flow");
      return false;
    } catch (error) {
      console.error(`Error executing command ${command}:`, error);
      await interaction.reply({
        content: "Sorry, there was an error processing your command.",
        ephemeral: true,
      });
      return true;
    }
  }

  private setInteractionHandler(): void {
    this.client.on("interactionCreate", async (interaction) => {
      if (!interaction.isChatInputCommand()) return;

      const command = interaction.commandName;

      // Check external commands first
      if (
        await this.pyfiCommand(
          interaction,
          command,
          interaction.options.getString("args") ?? ""
        )
      ) {
        return;
      }

      // Check internal commands
      const commandHandler = this.commands.get(command);
      if (commandHandler) {
        try {
          await commandHandler(interaction);
        } catch (error) {
          console.error(`Error executing command ${command}:`, error);
          await interaction.reply({
            content: "An error occurred while executing the command.",
            ephemeral: true,
          });
        }
      }
    });
  }
}
