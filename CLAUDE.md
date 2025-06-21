# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is a Discord bot that serves as a bridge between Discord and pyfibot lambda functions. The bot is written in TypeScript and uses Discord.js v14 with slash commands.

## Development Commands

- `npm run build` - Compile TypeScript to JavaScript in dist/
- `npm run dev` - Build and start the application for development
- `npm start` - Run the compiled application from dist/app.js
- `npm run lint` - Run ESLint on TypeScript files in src/
- `task build` - Alternative build command using Taskfile
- `task deploy` - Full deployment pipeline (build, upload, install, restart)

## Architecture

### Core Components

- `src/app.ts` - Entry point that initializes the bot singleton and connects
- `src/DiscordBot.ts` - Main bot class implementing singleton pattern with:
  - Discord client initialization with required intents
  - Slash command registration (weather, help)
  - Command handling system with internal and external command routing
  - Integration with AWS Lambda functions via `pyfiCommand()` method

### Command System

The bot has a hybrid command architecture:
1. **Internal commands** - Handled locally by the bot (help command)
2. **External commands** - Proxied to AWS Lambda functions via HTTP API (weather command)

External commands use environment variables:
- `LAMBDA_URL` - Lambda function endpoint
- `LAMBDA_APIKEY` - API key for Lambda authentication

### Environment Configuration

Required environment variables:
- `DISCORD_KEY` - Discord bot token
- `CLIENT_ID` - Discord application client ID  
- `GUILD_ID` - Discord guild (server) ID for command registration
- `LAMBDA_URL` - (Optional) Lambda function URL for external commands
- `LAMBDA_APIKEY` - (Optional) Lambda API key

### Build System

- TypeScript compilation to CommonJS modules
- Webpack configuration available but not actively used in npm scripts
- Target ES6 with strict type checking enabled
- Output directory: `dist/`

### Deployment

Uses Taskfile.yml for deployment automation:
- Builds application locally
- Syncs files to remote server via rsync
- Installs dependencies on server
- Manages PM2 process for application restart

Environment variables for deployment:
- `DEPLOY_SERVER_USER` - SSH username
- `DEPLOY_SERVER_HOST` - Server hostname
- `DEPLOY_PATH` - Remote deployment path