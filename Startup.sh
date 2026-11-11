#!/bin/bash

# --- Color Definitions ---
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo -e "${BLUE}=== Starting Relay Port Checker & Launcher ===${NC}"

# --- Load Environment Variables ---
FRONTEND_PORT=8090
BACKEND_PORT=8890

if [ -f .env ]; then
  echo -e "${GREEN}Found .env file. Loading environment variables...${NC}"
  # Read ports from .env if defined
  ENV_FRONTEND_PORT=$(grep -E "^FRONTEND_PORT=" .env | cut -d'=' -f2 | tr -d '\r' | xargs)
  if [ -n "$ENV_FRONTEND_PORT" ]; then
    FRONTEND_PORT=$ENV_FRONTEND_PORT
  fi
  ENV_BACKEND_PORT=$(grep -E "^BACKEND_PORT=" .env | cut -d'=' -f2 | tr -d '\r' | xargs)
  if [ -n "$ENV_BACKEND_PORT" ]; then
    BACKEND_PORT=$ENV_BACKEND_PORT
  fi
fi

echo -e "Target frontend port: ${YELLOW}${FRONTEND_PORT}${NC}"
echo -e "Target backend port:  ${YELLOW}${BACKEND_PORT}${NC}"

# --- Port Release Function ---
release_port() {
  local port=$1
  echo -e "Checking port ${YELLOW}${port}${NC}..."

  # Find PIDs using the port
  # lsof options: -t (terse/PIDs only), -i (internet/network), tcp:port
  local pids=$(lsof -t -i tcp:${port} 2>/dev/null)

  if [ -n "$pids" ]; then
    echo -e "Port ${YELLOW}${port}${NC} is currently occupied by PID(s): ${RED}${pids}${NC}. Releasing..."
    for pid in $pids; do
      kill -9 "$pid" 2>/dev/null
      if [ $? -eq 0 ]; then
        echo -e "${GREEN}Successfully terminated process ${pid}${NC}"
      else
        echo -e "${RED}Failed to terminate process ${pid}. Trying with sudo...${NC}"
        sudo kill -9 "$pid" 2>/dev/null
      fi
    done
  else
    echo -e "Port ${YELLOW}${port}${NC} is ${GREEN}free${NC}."
  fi
}

# --- Release Ports ---
release_port $FRONTEND_PORT
release_port $BACKEND_PORT

# --- Start the app ---
echo -e "${BLUE}Starting the application...${NC}"
npm run dev
