#!/bin/bash
npm run build
pm2 start dist/app.js --name discord-bot