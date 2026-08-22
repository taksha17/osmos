#!/bin/bash
# OSMOS Linux Installer with Auto-Dependency Management
set -e

echo "OSMOS Installer for Linux"
echo "=========================="

# Required node version
REQUIRED_NODE="22.22.2"
REQUIRED_NPM="10.9.7"

# Check architecture
ARCH=$(uname -m)
case $ARCH in
  x86_64) NODE_ARCH="linux-x64";;
  aarch64) NODE_ARCH="linux-arm64";;
  *) echo "Unsupported architecture: $ARCH"; exit 1;;
esac

# Function to install Node.js from tarball
install_node() {
  echo "Installing Node.js v$REQUIRED_NODE..."
  
  TMP_DIR=$(mktemp -d)
  NODE_URL="https://nodejs.org/dist/v${REQUIRED_NODE}/node-v${REQUIRED_NODE}-${NODE_ARCH}.tar.xz"
  
  cd $TMP_DIR
  wget -q $NODE_URL -O node.tar.xz
  tar -xf node.tar.xz
  sudo cp -r node-v${REQUIRED_NODE}-${NODE_ARCH}/{bin,lib,include,share} /usr/local/
  cd -
  
  rm -rf $TMP_DIR
  echo "Node.js installed successfully"
}

# Check Node.js installation
if command -v node >/dev/null 2>&1; then
  NODE_VERSION=$(node --version | sed 's/v//')
  
  # Compare versions
  NODE_MAJOR=$(echo $NODE_VERSION | cut -d. -f1)
  REQUIRED_MAJOR=$(echo $REQUIRED_NODE | cut -d. -f1)
  
  if [ "$NODE_MAJOR" -lt "$REQUIRED_MAJOR" ]; then
    echo "Node.js version too old (found $NODE_VERSION, required v$REQUIRED_NODE)"
    install_node
  fi
else
  echo "Node.js not installed"
  install_node
fi

echo "Node.js $(node --version)"
echo "npm $(npm --version)"

# Check for system dependencies
check_system_deps() {
  local MISSING=()
  
  # Common dependencies
  for dep in libfuse2 libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 libcups2 libxkbcommon0 libgtk-3-0; do
    if ! dpkg -l "$dep" >/dev/null 2>&1; then
      MISSING+=("$dep")
    fi
  done
  
  # Audio capture dependencies for system audio / Smart assist
  for dep in pipewire pulseaudio-utils; do
    if ! dpkg -l "$dep" >/dev/null 2>&1; then
      MISSING+=("$dep")
    fi
  done
  
  if [ ${#MISSING[@]} -ne 0 ]; then
    echo "Installing missing system dependencies..."
    sudo apt-get update
    sudo apt-get install -y "${MISSING[@]}" || {
      echo "Warning: Could not install all system dependencies automatically."
      echo "Please install manually: ${MISSING[*]}"
    }
  fi
}

# Only check apt-based systems
if [ -f "/etc/debian_version" ] || [ -f "/etc/apt/sources.list" ]; then
  check_system_deps
fi

echo "All dependencies satisfied!"
echo "Starting OSMOS..."