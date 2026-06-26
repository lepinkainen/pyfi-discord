#!/bin/bash
set -euo pipefail
pm2 startOrReload ecosystem.config.js
