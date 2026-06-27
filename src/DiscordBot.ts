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
  Message,
} from "discord.js";
import axios from "axios";
import Anthropic from "@anthropic-ai/sdk";
import { datasetForChannel } from "./rag/datasets";
import { datasetReady, search } from "./rag/store";
import { embedQuery } from "./rag/embeddings";

export class DiscordBot {
  private static instance: DiscordBot;
  private commands: Collection<
    string,
    (interaction: ChatInputCommandInteraction) => Promise<void>
  > = new Collection();

  private externalCommands: Set<string> = new Set(["weather"]);

  // Proactive-reply feature: lazily created Anthropic client + per-channel cooldown.
  private anthropic?: Anthropic;
  private proactiveCooldowns: Map<string, number> = new Map();
  private static readonly PROACTIVE_PASS = "[[PASS]]";
  private static readonly PROACTIVE_MIN_LENGTH = 8;

  private client: Client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
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
    this.setMessageHandler();
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
    this.client.on("clientReady", () => {
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

  /**
   * Proactive replies: the bot reads ordinary messages in whitelisted channels
   * and decides on its own whether to weigh in. Disabled unless both
   * ANTHROPIC_API_KEY and PROACTIVE_CHANNELS are set (mirrors how pyfiCommand
   * degrades when its env vars are missing).
   */
  private proactiveDebug(msg: string): void {
    if (process.env.PROACTIVE_DEBUG) {
      console.log(`[proactive] ${msg}`);
    }
  }

  /** True when the message directly @mentions the bot user. */
  private isDirectMention(message: Message): boolean {
    return (
      !message.author.bot &&
      !!this.client.user &&
      message.mentions.has(this.client.user.id)
    );
  }

  private setMessageHandler(): void {
    this.client.on("messageCreate", async (message) => {
      try {
        const directed = this.isDirectMention(message);
        this.proactiveDebug(
          `messageCreate fired: channel=${message.channelId} author=${message.author.username} bot=${message.author.bot} directed=${directed} len=${message.content.length} content="${message.content.slice(0, 60)}"`
        );
        if (!this.shouldConsiderMessage(message, directed)) return;
        await this.generateProactiveReply(message, directed);
      } catch (error) {
        // Never let a handler error crash the gateway connection.
        console.error("Error in proactive message handler:", error);
      }
    });
  }

  /**
   * Cheap local pre-filter — the inexpensive half of the hybrid gate. Returns
   * true only for messages worth spending an LLM call on. A direct @mention
   * bypasses the whitelist, length, prefix, and cooldown limiters — the user
   * explicitly asked the bot, so it always answers.
   */
  private shouldConsiderMessage(message: Message, directed: boolean): boolean {
    // Mandatory: never react to bots (including ourselves) — prevents reply loops.
    if (message.author.bot) {
      this.proactiveDebug("skip: author is a bot");
      return false;
    }

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      this.proactiveDebug("skip: feature disabled (no ANTHROPIC_API_KEY)");
      return false;
    }

    // Direct mention: skip every limiter below.
    if (directed) {
      this.proactiveDebug("directed mention -> bypassing limiters");
      return true;
    }

    const whitelist = (process.env.PROACTIVE_CHANNELS ?? "")
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean);
    if (whitelist.length === 0) {
      this.proactiveDebug("skip: feature disabled (empty PROACTIVE_CHANNELS)");
      return false;
    }

    if (!whitelist.includes(message.channelId)) {
      this.proactiveDebug(
        `skip: channel ${message.channelId} not in whitelist [${whitelist.join(", ")}]`
      );
      return false;
    }

    const content = message.content.trim();
    if (content.length < DiscordBot.PROACTIVE_MIN_LENGTH) {
      this.proactiveDebug(`skip: too short (${content.length} chars)`);
      return false;
    }
    // Skip slash/prefix-style commands.
    if (/^[!/.]/.test(content)) {
      this.proactiveDebug("skip: command-prefixed message");
      return false;
    }

    // Per-channel cooldown to cap spend and avoid spamming.
    const cooldownMs = Number(process.env.PROACTIVE_COOLDOWN_MS ?? 30000);
    const last = this.proactiveCooldowns.get(message.channelId) ?? 0;
    if (Date.now() - last < cooldownMs) {
      this.proactiveDebug(
        `skip: cooldown (${Date.now() - last}ms < ${cooldownMs}ms)`
      );
      return false;
    }

    this.proactiveDebug("passed pre-filter -> calling Claude");
    return true;
  }

  private getAnthropic(): Anthropic {
    if (!this.anthropic) {
      this.anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    }
    return this.anthropic;
  }

  /**
   * Calls the pyfibot Lambda backend and returns its plaintext result. Shared
   * shape with pyfiCommand() (the slash-command path) but decoupled from any
   * Discord interaction so it can back a Claude tool call.
   */
  private async callLambda(
    command: string,
    args: string,
    user: string
  ): Promise<string> {
    const lambdafunc = process.env.LAMBDA_URL;
    const apiKey = process.env.LAMBDA_APIKEY;
    if (!lambdafunc || !apiKey) return "Lambda backend is not configured.";

    const res = await axios.post(
      lambdafunc,
      { command, args, user },
      { headers: { "x-api-key": apiKey }, timeout: 5000 }
    );

    if (res.status === 200 && res.data.errorType === undefined) {
      return (res.data.result as string) ?? "";
    }
    return "No response from the command backend.";
  }

  /**
   * Builds the tool set offered to Claude for proactive replies. Each tool is
   * only included when its backing capability is available/enabled.
   */
  private buildProactiveTools(
    dataset?: string
  ): Anthropic.MessageCreateParams["tools"] {
    const tools: NonNullable<Anthropic.MessageCreateParams["tools"]> = [];

    if (process.env.PROACTIVE_WEB_SEARCH) {
      tools.push({ type: "web_search_20260209", name: "web_search" });
    }

    // Knowledge base for this channel's linked dataset (e.g. a TTRPG rulebook).
    if (dataset) {
      tools.push({
        name: "search_rules",
        description:
          `Search the ${dataset} rulebook/knowledge base for relevant passages. ` +
          "Use this for any rules, lore, or how-to question about this game. " +
          "Returns matching excerpts, each tagged with its source page like [p.27]. " +
          "Cite the page number(s) in your answer.",
        input_schema: {
          type: "object",
          properties: {
            query: {
              type: "string",
              description: "What to look up, e.g. 'how to create a character'.",
            },
          },
          required: ["query"],
        },
      });
    }

    if (process.env.LAMBDA_URL && process.env.LAMBDA_APIKEY) {
      tools.push({
        name: "pyfibot",
        description:
          "Call the pyfibot backend for live data. Supported commands include 'weather' (args = a location). Returns a plaintext result.",
        input_schema: {
          type: "object",
          properties: {
            command: { type: "string", description: "The command name, e.g. weather" },
            args: { type: "string", description: "Arguments for the command, e.g. a location" },
          },
          required: ["command", "args"],
        },
      });
    }

    tools.push(
      {
        name: "fetch_history",
        description:
          "Fetch more recent messages from this channel than the snippet already provided, for additional context.",
        input_schema: {
          type: "object",
          properties: {
            limit: {
              type: "integer",
              description: "How many recent messages to fetch (max 50).",
            },
          },
          required: ["limit"],
        },
      },
      {
        name: "lookup_user",
        description:
          "Look up a member of this server by username or display name to get their display name, roles, and join date.",
        input_schema: {
          type: "object",
          properties: {
            query: { type: "string", description: "Username or display name to search for." },
          },
          required: ["query"],
        },
      }
    );

    return tools;
  }

  /**
   * Executes a single custom (client-side) tool call and returns text for the
   * tool_result. Server-side tools (web_search) are handled by Anthropic and
   * never reach here.
   */
  private async runProactiveTool(
    message: Message,
    name: string,
    input: Record<string, unknown>,
    dataset?: string
  ): Promise<string> {
    try {
      if (name === "search_rules") {
        if (!dataset) return "No knowledge base is linked to this channel.";
        const query = String(input.query ?? "").trim();
        if (!query) return "Provide a query to search for.";
        const vec = await embedQuery(query);
        const hits = search(dataset, vec, 5);
        if (hits.length === 0) return `No matching passages in the ${dataset} knowledge base.`;
        return hits
          .map((h) => `[p.${h.page}] ${h.text}`)
          .join("\n\n---\n\n")
          .slice(0, 4000);
      }

      if (name === "pyfibot") {
        const result = await this.callLambda(
          String(input.command ?? ""),
          String(input.args ?? ""),
          message.author.username
        );
        return result.slice(0, 1500);
      }

      if (name === "fetch_history") {
        const limit = Math.min(Math.max(Number(input.limit) || 10, 1), 50);
        const fetched = await message.channel.messages.fetch({ limit });
        return [...fetched.values()]
          .reverse()
          .map((m) => `${m.author.username}: ${m.content}`)
          .join("\n")
          .slice(0, 2000);
      }

      if (name === "lookup_user") {
        const query = String(input.query ?? "").toLowerCase();
        const guild = message.guild;
        if (!guild) return "Not in a server context.";
        const members = await guild.members.fetch({ query: String(input.query ?? ""), limit: 5 });
        const match =
          members.find(
            (m) =>
              m.user.username.toLowerCase() === query ||
              m.displayName.toLowerCase() === query
          ) ?? members.first();
        if (!match) return `No member found matching "${input.query}".`;
        const roles = match.roles.cache
          .filter((r) => r.name !== "@everyone")
          .map((r) => r.name)
          .join(", ");
        return [
          `Display name: ${match.displayName}`,
          `Username: ${match.user.username}`,
          `Roles: ${roles || "none"}`,
          `Joined: ${match.joinedAt?.toISOString() ?? "unknown"}`,
        ].join("\n");
      }

      return `Unknown tool: ${name}`;
    } catch (error) {
      console.error(`Proactive tool '${name}' failed:`, error);
      return `Tool '${name}' failed.`;
    }
  }

  /**
   * The expensive half of the gate: a bounded agentic loop where Claude can call
   * tools (web search, pyfibot, Discord context) before deciding whether to
   * respond. Claude returns the sentinel PROACTIVE_PASS when it has nothing to add.
   */
  private async generateProactiveReply(
    message: Message,
    directed: boolean
  ): Promise<void> {
    // Mark the cooldown up front so concurrent messages don't each fire a call.
    this.proactiveCooldowns.set(message.channelId, Date.now());

    // Recent channel context, oldest-first.
    const fetched = await message.channel.messages.fetch({ limit: 10 });
    const transcript = [...fetched.values()]
      .reverse()
      .map((m) => `${m.author.username}: ${m.content}`)
      .join("\n");

    const model = process.env.PROACTIVE_MODEL ?? "claude-sonnet-4-6";

    // Knowledge base linked to this channel, if any (and actually indexed).
    const linked = datasetForChannel(message.channelId);
    const dataset = linked && datasetReady(linked) ? linked : undefined;
    const kbHint = dataset
      ? ` This channel is about the "${dataset}" game; use the search_rules tool to answer rules/lore questions and cite page numbers (e.g. "(p.27)").`
      : "";

    const system = directed
      ? [
          "You are a Discord chat bot. A user has directly @mentioned you and is asking you something.",
          "Always answer their request helpfully and directly — do not stay silent.",
          "Use the available tools to look things up when they help.",
          "Reply ONLY with the message to post — no preamble, no quotes, no meta-commentary, under 1500 characters.",
        ].join(" ") + kbHint
      : [
          "You are a Discord chat bot that occasionally chimes in on a channel's conversation.",
          "Only respond when you can genuinely add value: a useful fact, a correction, a helpful answer, or a well-placed bit of wit.",
          "Stay silent for small talk, greetings, or anything where a reply would be noise.",
          "You may use the available tools to look things up before deciding.",
          `If you should NOT respond, reply with exactly ${DiscordBot.PROACTIVE_PASS} and nothing else.`,
          "Otherwise reply ONLY with the message to post — no preamble, no quotes, no meta-commentary, under 1500 characters.",
        ].join(" ") + kbHint;

    // Show "Bot is typing..." while the agentic loop runs. The indicator expires
    // after ~10s, so refresh it on an interval until we finish. Only for directed
    // mentions — those always answer; an unprompted reply may PASS, and typing
    // then going silent (ghost-typing) looks broken.
    let typing: NodeJS.Timeout | undefined;
    if (directed && "sendTyping" in message.channel) {
      const channel = message.channel;
      const ping = () => channel.sendTyping().catch(() => undefined);
      ping();
      typing = setInterval(ping, 8000);
    }

    const tools = this.buildProactiveTools(dataset);
    const messages: Anthropic.MessageParam[] = [
      {
        role: "user",
        content: `Recent channel messages:\n${transcript}\n\nThe latest message is from ${message.author.username}. Decide whether to weigh in.`,
      },
    ];

    const MAX_ITERS = 5;
    let response: Anthropic.Message | undefined;

    try {
    for (let i = 0; i < MAX_ITERS; i++) {
      try {
        response = await this.getAnthropic().messages.create({
          model,
          max_tokens: 2048,
          system,
          tools,
          messages,
        });
      } catch (error) {
        if (error instanceof Anthropic.APIError) {
          console.error(`Anthropic API error (${error.status}):`, error.message);
        } else {
          console.error("Anthropic request failed:", error);
        }
        return;
      }

      this.proactiveDebug(`iteration ${i}: stop_reason=${response.stop_reason}`);

      // Server-side tool (web_search) ran; re-send to let Claude continue.
      if (response.stop_reason === "pause_turn") {
        messages.push({ role: "assistant", content: response.content });
        continue;
      }

      // Custom tool calls: execute locally and feed results back.
      if (response.stop_reason === "tool_use") {
        messages.push({ role: "assistant", content: response.content });
        const toolUses = response.content.filter(
          (block): block is Anthropic.ToolUseBlock => block.type === "tool_use"
        );
        const results: Anthropic.ToolResultBlockParam[] = [];
        for (const tu of toolUses) {
          this.proactiveDebug(`tool call: ${tu.name} input=${JSON.stringify(tu.input)}`);
          const out = await this.runProactiveTool(
            message,
            tu.name,
            tu.input as Record<string, unknown>,
            dataset
          );
          this.proactiveDebug(`tool result (${tu.name}): ${out.slice(0, 120)}`);
          results.push({ type: "tool_result", tool_use_id: tu.id, content: out });
        }
        messages.push({ role: "user", content: results });
        continue;
      }

      break; // end_turn / refusal / max_tokens
    }

    const text = (response?.content ?? [])
      .filter((block): block is Anthropic.TextBlock => block.type === "text")
      .map((block) => block.text)
      .join("")
      .trim();

    if (!text) {
      this.proactiveDebug("Claude returned no text; staying silent");
      return;
    }

    // PASS only applies to unprompted proactive replies; a direct mention always answers.
    if (!directed && text.includes(DiscordBot.PROACTIVE_PASS)) {
      this.proactiveDebug(`Claude verdict: PASS (raw="${text.slice(0, 60)}")`);
      return;
    }

    // Strip a stray sentinel a directed reply may have appended.
    const reply = text.split(DiscordBot.PROACTIVE_PASS).join("").trim();
    if (!reply) {
      this.proactiveDebug("Claude verdict: empty after sentinel strip; silent");
      return;
    }

    this.proactiveDebug(`Claude verdict: REPLY (${reply.length} chars)`);
    await message.reply(reply.slice(0, 2000));
    } finally {
      if (typing) clearInterval(typing);
    }
  }
}
