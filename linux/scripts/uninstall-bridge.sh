#!/usr/bin/env bash
# Remove the OSMOS Stealth Bridge from the current user's GNOME Shell.
# Settings stored in dconf are left in place; the next install reuses them.
#
# OSMOS_BRIDGE_NO_ENABLE=1 removes files only (installer self-test).
set -uo pipefail

UUID="osmos-bridge@osmos.app"
DATA_HOME="${XDG_DATA_HOME:-$HOME/.local/share}"
DEST="$DATA_HOME/gnome-shell/extensions/$UUID"
SKIP_ENABLE="${OSMOS_BRIDGE_NO_ENABLE:-0}"

disable_extension() {
  [ "$SKIP_ENABLE" = "1" ] && return 0

  if command -v gnome-extensions >/dev/null 2>&1 && gnome-extensions disable "$UUID" 2>/dev/null; then
    return 0
  fi

  # The running Shell may not know the extension; remove it from the same
  # GSettings key so the next login does not try to load a deleted directory.
  if command -v gjs >/dev/null 2>&1; then
    gjs -c "const Gio = imports.gi.Gio; const s = new Gio.Settings({schema_id: 'org.gnome.shell'}); const ids = s.get_strv('enabled-extensions'); const i = ids.indexOf('$UUID'); if (i >= 0) { ids.splice(i, 1); s.set_strv('enabled-extensions', ids); }" 2>/dev/null || true
  fi
}

disable_extension

rm -rf "$DEST"
echo "Removed $DEST"
echo "A running Shell keeps the extension loaded until it restarts; log out and back in to unload it fully."
