import {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  Collection,
  ApplicationCommandDataResolvable,
  MessageFlags,
} from "discord.js";
import axios from "axios";

export class DiscordBot {
  private static instance: DiscordBot;
  private commands: Collection<
    string,
    (interaction: ChatInputCommandInteraction) => Promise<void>
  > = new Collection();

  private externalCommands: Set<string> = new Set(["weather"]);

  private client: Client = new Client({
    intents: [GatewayIntentBits.Guilds],
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

    try {
      await this.client.login(process.env.DISCORD_KEY);
      console.log("Connected to Discord");
    } catch (error) {
      console.error("Could not connect to Discord:", error);
      throw error;
    }
  }

  private async registerSlashCommands(): Promise<void> {
    const commands: ApplicationCommandDataResolvable[] = [
      new SlashCommandBuilder()
        .setName("weather")
        .setDescription("Get weather for a location")
        .addStringOption((option) =>
          option
            .setName("location")
            .setDescription("The city to get weather for")
            .setRequired(true)
        )
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
    this.registerCommandHandlers();
    this.setReadyHandler();
    this.setInteractionHandler();
  }

  private registerCommandHandlers(): void {
    this.commands.set(
      "weather",
      async (interaction: ChatInputCommandInteraction) => {
        const location = interaction.options.getString("location");
        await interaction.reply(
          location
            ? `Weather backend is not configured right now for "${location}".`
            : "Weather backend is not configured right now."
        );
      }
    );

    this.commands.set("help", async (interaction: ChatInputCommandInteraction) => {
      const helpMessage = [
        "**Available Commands:**",
        "/weather <location> - Get weather for a location",
        "/help - Show this help message",
      ].join("\n");

      await interaction.reply(helpMessage);
    });
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
    const lambdafunc = process.env.LAMBDA_URL;
    const apiKey = process.env.LAMBDA_APIKEY;

    if (!lambdafunc || !apiKey) {
      console.info("Lambda not configured, falling back to internal commands");
      return false;
    }

    try {
      await interaction.deferReply();
      console.debug(
        `External command '${command}' called with arguments: '${args}'`
      );

      const res = await axios.post(
        lambdafunc,
        {
          command,
          args,
          user: interaction.user.username,
        },
        {
          headers: { "x-api-key": apiKey },
          timeout: 5000,
        }
      );

      if (res.status === 200 && res.data.errorType === undefined) {
        const apiresult = res.data.result as string;

        if (apiresult.startsWith("Unknown command:")) {
          await interaction.editReply("This command is not supported by Lambda.");
          return true;
        }

        if (command === "weather") {
          const match = apiresult.match(
            /(.+): Temperature: ([-\d.]+)°C, feels like: ([-\d.]+)°C, wind: ([\d.]+) m\/s, humidity: (\d+)%, pressure: (\d+)hPa, cloudiness: (\d+)%/
          );

          if (match) {
            const [
              _,
              location,
              temp,
              feelsLike,
              wind,
              humidity,
              pressure,
              clouds,
            ] = match;
            const weatherEmbed = {
              color: 0x0099ff,
              title: `🌡️ Weather in ${location}`,
              fields: [
                {
                  name: "Temperature",
                  value: `${temp}°C\n(Feels like ${feelsLike}°C)`,
                  inline: true,
                },
                {
                  name: "Wind",
                  value: `💨 ${wind} m/s`,
                  inline: true,
                },
                {
                  name: "Humidity",
                  value: `💧 ${humidity}%`,
                  inline: true,
                },
                {
                  name: "Conditions",
                  value: `☁️ ${clouds}% cloudy\n📊 ${pressure}hPa`,
                  inline: true,
                },
              ],
              timestamp: new Date().toISOString(),
              footer: {
                text: "Weather information",
              },
            };
            await interaction.editReply({ embeds: [weatherEmbed] });
          } else {
            await interaction.editReply("Sorry, couldn't parse the weather data.");
          }
        } else if (res.data.result !== undefined && res.data.result !== "") {
          await interaction.editReply(res.data.result);
        }

        return true;
      }

      await interaction.editReply("No response from external command backend.");
      return true;
    } catch (error) {
      console.error(`Error executing command ${command}:`, error);
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({
          content: "Sorry, there was an error processing your command.",
          flags: MessageFlags.Ephemeral,
        });
      } else {
        await interaction.editReply("Sorry, there was an error processing your command.");
      }
      return true;
    }
  }

  private async runInternalCommand(
    interaction: ChatInputCommandInteraction,
    command: string
  ): Promise<void> {
    const commandHandler = this.commands.get(command);
    if (!commandHandler) {
      await interaction.reply({
        content: "Unknown command.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    try {
      await commandHandler(interaction);
    } catch (error) {
      console.error(`Error executing command ${command}:`, error);
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({
          content: "An error occurred while executing the command.",
          flags: MessageFlags.Ephemeral,
        });
      } else {
        await interaction.editReply("An error occurred while executing the command.");
      }
    }
  }

  private setInteractionHandler(): void {
    this.client.on("interactionCreate", async (interaction) => {
      if (!interaction.isChatInputCommand()) return;

      const command = interaction.commandName;

      if (this.externalCommands.has(command)) {
        const args = interaction.options.getString("location") ?? "";
        const handledExternally = await this.pyfiCommand(interaction, command, args);
        if (handledExternally) return;
      }

      await this.runInternalCommand(interaction, command);
    });
  }
}
