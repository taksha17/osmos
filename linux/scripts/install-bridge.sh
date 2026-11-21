#!/usr/bin/env bash
# Install the OSMOS Stealth Bridge into the current user's GNOME Shell.
#
#   bash linux/scripts/install-bridge.sh [--link]
#
# Default copies the extension, so a packaged OSMOS that is moved or removed
# cannot break the installed bridge. --link symlinks to this checkout instead,
# which is the fast loop while editing extension.js.
#
# No sudo: user extensions live in ~/.local/share/gnome-shell/extensions.
#
# Setting OSMOS_BRIDGE_NO_ENABLE=1 copies the files but does not touch the
# shell's enabled-extensions list (used by the installer self-test).
set -euo pipefail

UUID="osmos-bridge@osmos.app"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC="$HERE/../gnome-extension/$UUID"
DATA_HOME="${XDG_DATA_HOME:-$HOME/.local/share}"
DEST="$DATA_HOME/gnome-shell/extensions/$UUID"
SKIP_ENABLE="${OSMOS_BRIDGE_NO_ENABLE:-0}"
LINK=0

for arg in "$@"; do
  case "$arg" in
    --link) LINK=1 ;;
    -h|--help)
      sed -n '2,13p' "${BASH_SOURCE[0]}"
      exit 0
      ;;
    *)
      echo "Unknown argument: $arg" >&2
      echo "Usage: install-bridge.sh [--link]" >&2
      exit 2
      ;;
  esac
done

if [ ! -d "$SRC" ]; then
  echo "Extension source not found: $SRC" >&2
  exit 2
fi

if ! command -v glib-compile-schemas >/dev/null 2>&1; then
  echo "glib-compile-schemas is required (sudo apt install libglib2.0-dev-bin)" >&2
  exit 3
fi

mkdir -p "$(dirname "$DEST")"
rm -rf "$DEST"

if [ "$LINK" = "1" ]; then
  ln -sfn "$SRC" "$DEST"
else
  mkdir -p "$DEST"
  cp -a "$SRC/." "$DEST/"
fi

glib-compile-schemas "$DEST/schemas"

echo "Installed $UUID to $DEST"

# A running Wayland Shell cannot load a newly copied extension: gnome-extensions
# may refuse, and even a successful call would not take effect until the next
# session. Either path still records the UUID so the next login starts it.
enable_extension() {
  if [ "$SKIP_ENABLE" = "1" ]; then
    echo "OSMOS_BRIDGE_NO_ENABLE=1 — left enabled-extensions untouched."
    return 0
  fi

  if command -v gnome-extensions >/dev/null 2>&1 && gnome-extensions enable "$UUID" 2>/dev/null; then
    local state
    state="$(gnome-extensions info "$UUID" 2>/dev/null | awk -F': ' '/State/{print $2; exit}')"
    echo "Enabled $UUID${state:+ (state: $state)}"
    return 0
  fi

  # gnome-extensions validates against the running Shell's extension list, which
  # does not contain a just-installed extension. Write the same GSettings key it
  # would have written; the next Shell start loads it.
  if command -v gjs >/dev/null 2>&1; then
    if gjs -c "const Gio = imports.gi.Gio; const s = new Gio.Settings({schema_id: 'org.gnome.shell'}); const ids = s.get_strv('enabled-extensions'); if (!ids.includes('$UUID')) { ids.push('$UUID'); s.set_strv('enabled-extensions', ids); }" 2>/dev/null; then
      echo "Added $UUID to enabled-extensions — it starts with your next login."
      return 0
    fi
  fi

  echo "Could not enable yet. After logging back in run: gnome-extensions enable $UUID"
  return 1
}

enable_extension || true

echo "Wayland cannot reload the Shell in place. Log out and back in, then check:"
echo "  gnome-extensions prefs $UUID"
