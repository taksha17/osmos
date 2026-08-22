#!/usr/bin/env bash
# OSMOS macOS Installer with Auto-Dependency Management

set -e

PRODUCT_NAME="OSMOS"
REQUIRED_NODE="22.22.2"

echo "=== Installing $PRODUCT_NAME on macOS ==="

# Check for Homebrew and install if necessary
if ! command -v brew &> /dev/null; then
  echo "Installing Homebrew..."
  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
fi

# Install Node.js via Homebrew
echo "Installing Node.js v$REQUIRED_NODE..."
brew install node@$REQUIRED_NODE || {
  echo "Failed to install Node.js. Please install manually: brew install node@$REQUIRED_NODE"
  exit 1
}

# Verify Node.js installation
if ! command -v node &> /dev/null; then
  echo "ERROR: Node.js not found after installation."
  exit 1
fi

# Configure PATH for current session
case $(uname -m) in
  arm64) NVM_DIR="$HOME/.nvm";;
  x86_64) NVM_DIR="$HOME/.nvm";;
esac

source "$(brew --prefix)/bin/env -"

NODE_VERSION=$(node --version)
if [[ "$(node --version)" != "v$REQUIRED_NODE"* ]]; then
  echo "Warning: Node.js version mismatch. Found: $(node --version), Expected: v$REQUIRED_NODE*"
fi

echo "Node.js $(node --version)"
echo "npm $(npm --version)"

# Check for system dependencies
echo "Checking system dependencies..."
if ! command -v ffmpeg &> /dev/null; then
  echo "Installing ffmpeg..."
  brew install ffmpeg || {
    echo "Warning: Could not install ffmpeg automatically."
    echo "Please install manually: brew install ffmpeg"
  }
fi

# Check if virtual environment is available
if ! command -v python3 &> /dev/null; then
  echo "Python3 not found. Some packages may require it."
fi

# Check for required development tools
echo "Checking development tools..."
if ! command -v xcode-select &> /dev/null; then
  echo "Installing Xcode Command Line Tools..."
  xcode-select --install || {
    echo "Warning: Xcode Command Line Tools installation may have been cancelled."
    echo "Please install manually: xcode-select --install"
  }
fi

# Create application directory
declare -r APP_DIR="/Applications/${PRODUCT_NAME}.app"
if [ -d "$APP_DIR" ]; then
  echo "$APP_DIR already exists. Please remove it or install to a different location."
  read -p "Continue anyway? (y/n) " -n 1 -r
  echo
  if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    exit 1
  fi
fi

# Extract OSMOS package
echo "Extracting OSMOS package..."
cd /tmp
sudo tar -xzf /tmp/osmos-macos-installer.tar.gz -C /Applications || {
  echo "Failed to extract package. Please check /tmp/osmos-macos-installer.tar.gz"
  exit 1
}

# Fix permissions
sudo chown -R $(whoami):staff "/Applications/${PRODUCT_NAME}.app" || {
  echo "Warning: Could not change ownership."
}

# Create symlink for easy launch
echo "Creating LaunchAgent for auto-update..."
cat > $HOME/Library/LaunchAgents/io.osmos.agent.plist << 'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>io.osmos.agent</string>
    <key>ProgramArguments</key>
    <array>
        <string>/usr/local/bin/node</string>
        <string>/Applications/OSMOS/run-update.sh</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>StartInterval</key>
    <integer>3600</integer>
</dict>
</plist>
EOF

# Load the LaunchAgent
launchctl load $HOME/Library/LaunchAgents/io.osmos.agent.plist 2>/dev/null || {
  echo "Warning: Could not load LaunchAgent. Please load manually: launchctl load $HOME/Library/LaunchAgents/io.osmos.agent.plist"
}

echo "Installation complete!"
echo ""
echo "To start $PRODUCT_NAME:"
echo "  Open /Applications/OSMOS.app"
echo ""
echo "To uninstall:"
echo "  sudo rm -rf /Applications/OSMOS.app"
echo "  launchctl unload $HOME/Library/LaunchAgents/io.osmos.agent.plist"