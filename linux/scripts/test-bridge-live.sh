#!/usr/bin/env bash
# Live test of the OSMOS Stealth Bridge inside a real gnome-shell process.
#
#   bash linux/scripts/test-bridge-live.sh
#
# Starts a private-bus headless GNOME Shell (Wayland), loads the installed
# extension, maps a GTK window with WM_CLASS "osmos", then opens a real Mutter
# ScreenCast session and captures its PipeWire stream with GStreamer. That is
# the same compositor capture path meetings use, so the check proves what a
# viewer would receive rather than trusting the extension's own log.
#
# Checks:
#   1. org.osmos.Bridge answers (Ping/Mode/SharingActive)
#   2. the extension sees the Mutter cast (SharingActive true -> false)
#   3. mode=keep leaves the window in the capture (negative control)
#   4. mode=hide removes the window from the capture
#   5. the window comes back in the capture when the cast ends
#
# Requires gnome-shell, gdbus, gst-launch-1.0 (pipewiresrc), pw-dump,
# python3-gi and python3-pil. No sudo and no real desktop: everything runs in
# a throwaway D-Bus session and an isolated wayland socket.
set -euo pipefail

UUID="osmos-bridge@osmos.app"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DEST="${XDG_DATA_HOME:-$HOME/.local/share}/gnome-shell/extensions/$UUID"
SCHEMADIR="$DEST/schemas"
WAYLAND_NAME="osmos-bridge-test-$$"
TMP="$(mktemp -d)"
LOG="$TMP/shell.log"
ORIGINAL_MODE=""
SHELL_PID=""

cleanup() {
  [ -n "$SHELL_PID" ] && kill "$SHELL_PID" 2>/dev/null || true
  rm -rf "$TMP"
}
restore_mode() {
  if [ -n "$ORIGINAL_MODE" ] && [ -d "$SCHEMADIR" ]; then
    gsettings --schemadir "$SCHEMADIR" set org.gnome.shell.extensions.osmos-bridge \
      mode "'$ORIGINAL_MODE'" 2>/dev/null || true
  fi
}
trap 'restore_mode; cleanup' EXIT

if [ ! -d "$DEST" ] || [ ! -f "$SCHEMADIR/gschemas.compiled" ]; then
  echo "Extension not installed at $DEST. Run linux/scripts/install-bridge.sh first." >&2
  exit 2
fi
for tool in gnome-shell gdbus gst-launch-1.0 pw-dump; do
  if ! command -v "$tool" >/dev/null; then
    echo "$tool is required." >&2
    exit 2
  fi
done

ORIGINAL_MODE="$(gsettings --schemadir "$SCHEMADIR" get org.gnome.shell.extensions.osmos-bridge mode | tr -d "'")"
gsettings --schemadir "$SCHEMADIR" set org.gnome.shell.extensions.osmos-bridge mode "'hide'"

if ! gsettings get org.gnome.shell enabled-extensions | grep -q "$UUID"; then
  echo "$UUID is not in org.gnome.shell enabled-extensions; run the installer." >&2
  exit 2
fi

cat >"$TMP/window.py" <<'PY'
import gi
gi.require_version('Gtk', '3.0')
from gi.repository import Gtk, Gdk, GLib

GLib.set_prgname('osmos')  # becomes the Wayland app_id
screen = Gdk.Display.get_default().get_default_screen()
css = Gtk.CssProvider()
css.load_from_data(b'window { background-color: #ff00ff; }')
Gtk.StyleContext.add_provider_for_screen(screen, css, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION)
win = Gtk.Window(title='OSMOS bridge test')
win.set_wmclass('osmos', 'osmos')
win.set_default_size(640, 420)
win.connect('destroy', Gtk.main_quit)
win.show_all()
Gtk.main()
PY

# Holds the D-Bus connection open: Mutter closes a ScreenCast session when its
# owning connection goes away, so gdbus one-shots cannot keep a share alive.
cat >"$TMP/share.py" <<'PY'
import sys
import time

import gi
gi.require_version('Gio', '2.0')
from gi.repository import Gio, GLib

SERVICE = 'org.gnome.Mutter.ScreenCast'
ROOT = '/org/gnome/Mutter/ScreenCast'
bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)


def call(path, iface, method, args, reply):
    return bus.call_sync(
        SERVICE, path, iface, method, args,
        GLib.VariantType.new(reply) if reply else None,
        Gio.DBusCallFlags.NONE, -1, None,
    )


session = call(
    ROOT, 'org.gnome.Mutter.ScreenCast', 'CreateSession',
    GLib.Variant('(a{sv})', ({},)), '(o)',
).unpack()[0]
stream = call(
    session, 'org.gnome.Mutter.ScreenCast.Session', 'RecordMonitor',
    GLib.Variant('(sa{sv})', ('Meta-0', {})), '(o)',
).unpack()[0]
call(session, 'org.gnome.Mutter.ScreenCast.Session', 'Start', None, None)
print(f'START_MS={time.time_ns() // 1_000_000}', flush=True)
try:
    time.sleep(float(sys.argv[1]) if len(sys.argv) > 1 else 60)
finally:
    try:
        call(stream, 'org.gnome.Mutter.ScreenCast.Stream', 'Stop', None, None)
    except Exception:
        pass
PY

cat >"$TMP/colors.py" <<'PY'
import sys
from PIL import Image

im = Image.open(sys.argv[1]).convert('RGB')
px = im.load()
magenta = 0
for y in range(2, im.height, 2):
    for x in range(2, im.width, 2):
        r, g, b = px[x, y]
        if r > 200 and g < 60 and b > 200:
            magenta += 1
print(magenta)
PY

# All assertions run inside the private bus so gdbus/pw-dump see the test Shell.
dbus-run-session -- bash -s "$ROOT" "$DEST" "$SCHEMADIR" "$WAYLAND_NAME" "$TMP" "$LOG" "$ORIGINAL_MODE" 2>>"$TMP/bus.log" <<'OUTER'
set -euo pipefail
ROOT="$1"; DEST="$2"; SCHEMADIR="$3"; WAYLAND_NAME="$4"; TMP="$5"; LOG="$6"
ORIGINAL_MODE="$7"

export GSETTINGS_BACKEND="${GSETTINGS_BACKEND:-dconf}"
export WAYLAND_DISPLAY="$WAYLAND_NAME"
export GDK_BACKEND=wayland
FAILS=0

pass() { printf 'PASS  %s\n' "$1"; }
fail() { printf 'FAIL  %s\n' "$1"; FAILS=$((FAILS + 1)); }

bridge_prop() {
  gdbus call --session --dest org.osmos.Bridge --object-path /org/osmos/Bridge \
    --method org.freedesktop.DBus.Properties.Get org.osmos.Bridge "$1" 2>/dev/null \
    | grep -oE 'true|false|hide|keep|off' | head -1
}

wait_prop() { # name expected [ticks]
  local name="$1" expected="$2" ticks="${3:-200}"
  for _ in $(seq 1 "$ticks"); do
    if [ "$(bridge_prop "$name")" = "$expected" ]; then return 0; fi
    sleep 0.02
  done
  return 1
}

video_nodes() {
  pw-dump 2>/dev/null | python3 -c '
import json, sys
try:
    objects = json.load(sys.stdin)
except Exception:
    raise SystemExit(0)
for obj in objects:
    props = obj.get("info", {}).get("props", {})
    if (obj.get("type") == "PipeWire:Interface:Node"
            and props.get("media.class") == "Stream/Output/Video"
            and props.get("node.name") == "gnome-shell"):
        print(obj.get("id"))
'
}

start_cast() {
  : >"$TMP/share.out"
  python3 "$TMP/share.py" 120 >"$TMP/share.out" 2>"$TMP/share.err" &
  CAST_PID=$!
  for _ in $(seq 1 200); do
    grep -q 'START_MS=' "$TMP/share.out" && break
    sleep 0.05
  done
  if ! grep -q 'START_MS=' "$TMP/share.out"; then
    cat "$TMP/share.err" >&2
    return 1
  fi
  START_MS="$(sed -n 's/^START_MS=//p' "$TMP/share.out")"
  # Mutter exports a new Stream/Output/Video node; find the one that is new.
  local before="$1"
  NODE=""
  for _ in $(seq 1 100); do
    if [ -n "$before" ]; then
      NODE="$(comm -13 <(printf '%s\n' "$before" | sort) <(video_nodes | sort) | tail -1 || true)"
    else
      NODE="$(video_nodes | tail -1 || true)"
    fi
    [ -n "$NODE" ] && break
    sleep 0.05
  done
  [ -n "$NODE" ]
}

stop_cast() {
  [ -n "${CAST_PID:-}" ] && kill "$CAST_PID" 2>/dev/null || true
  CAST_PID=""
  sleep 1
}

capture() { # output
  timeout 20 gst-launch-1.0 -q pipewiresrc path="$NODE" num-buffers=1 \
    ! videoconvert ! pngenc ! filesink location="$1" >/dev/null 2>&1
  [ -s "$1" ]
}

magenta() { python3 "$TMP/colors.py" "$1" 2>/dev/null || echo 0; }

# 1. headless Shell + extension
gnome-shell --headless --wayland --wayland-display="$WAYLAND_NAME" \
  --virtual-monitor 1280x800 >"$LOG" 2>&1 &
SHELL_PID=$!
loaded=0
for _ in $(seq 1 600); do
  if gdbus call --session --dest org.osmos.Bridge --object-path /org/osmos/Bridge \
    --method org.osmos.Bridge.Ping >/dev/null 2>&1; then loaded=1; break; fi
  sleep 0.1
done
if [ "$loaded" = "1" ]; then
  pass "extension loaded and org.osmos.Bridge appeared"
else
  fail "org.osmos.Bridge did not appear"
  grep -iE 'osmos-bridge|error|exception' "$LOG" | tail -20 || true
  echo "--- private bus log ---"
  tail -20 "$TMP/bus.log" 2>/dev/null || true
  exit 1
fi

# Set the mode from inside the private session: its dconf service is the one
# the test Shell reads, and it may not notice a write made on another bus.
gsettings --schemadir "$SCHEMADIR" set org.gnome.shell.extensions.osmos-bridge mode "'hide'"
sleep 0.3

ping="$(gdbus call --session --dest org.osmos.Bridge --object-path /org/osmos/Bridge \
  --method org.osmos.Bridge.Ping 2>/dev/null || true)"
[ "$ping" = "('1',)" ] && pass "Ping -> $ping" || fail "Ping -> $ping"
[ "$(bridge_prop Mode)" = "hide" ] && pass "Mode -> hide" || fail "Mode -> $(bridge_prop Mode)"
wait_prop SharingActive false 100 && pass "SharingActive false before any share" \
  || fail "SharingActive not false before share"

gdbus monitor --session --dest org.osmos.Bridge >"$TMP/monitor.log" 2>&1 &
MON_PID=$!
sleep 0.3

# 2. window with WM_CLASS osmos
python3 "$TMP/window.py" >"$TMP/window.log" 2>&1 &
WIN_PID=$!
sleep 2

# 3. negative control: mode=keep, capture the actual stream and see the window
gsettings --schemadir "$SCHEMADIR" set org.gnome.shell.extensions.osmos-bridge mode "'keep'"
sleep 0.3
BASE_NODES="$(video_nodes)"
if start_cast "$BASE_NODES"; then
  wait_prop SharingActive true 150 && pass "extension saw the Mutter cast start" \
    || fail "extension did not report the Mutter cast"
  sleep 1
  if capture "$TMP/keep.png"; then
    keep_px="$(magenta "$TMP/keep.png")"
    [ "$keep_px" -gt 100 ] && pass "mode=keep: capture shows the window (magenta px=$keep_px)" \
      || fail "mode=keep window missing from capture (magenta px=$keep_px)"
  else
    fail "could not capture the ScreenCast stream (mode=keep)"
  fi
else
  fail "could not start the Mutter ScreenCast (mode=keep)"
fi
stop_cast

# 4. mode=hide: same cast path, window must not reach the capture
gsettings --schemadir "$SCHEMADIR" set org.gnome.shell.extensions.osmos-bridge mode "'hide'"
sleep 0.3
BASE_NODES="$(video_nodes)"
if start_cast "$BASE_NODES"; then
  if wait_prop SharingActive true 150; then
    late_ms=$(( $(date +%s%3N) - START_MS ))
    pass "extension hid for the cast (SharingActive true within ${late_ms}ms)"
  else
    fail "extension did not report the hiding cast"
  fi
  sleep 1
  if capture "$TMP/hide.png"; then
    hide_px="$(magenta "$TMP/hide.png")"
    [ "$hide_px" -lt 20 ] && pass "window absent from the capture while hidden (magenta px=$hide_px)" \
      || fail "window still in the capture while hidden (magenta px=$hide_px)"
  else
    fail "could not capture the ScreenCast stream (mode=hide)"
  fi
  gsettings --schemadir "$SCHEMADIR" set org.gnome.shell.extensions.osmos-bridge mode "'keep'"
  sleep 0.4
  if capture "$TMP/keep-again.png"; then
    again_px="$(magenta "$TMP/keep-again.png")"
    [ "$again_px" -gt 100 ] && pass "mode switch alone brings the window back (magenta px=$again_px)" \
      || fail "window did not return after mode switch (magenta px=$again_px)"
  fi
  gsettings --schemadir "$SCHEMADIR" set org.gnome.shell.extensions.osmos-bridge mode "'hide'"
else
  fail "could not start the Mutter ScreenCast (mode=hide)"
fi
stop_cast
wait_prop SharingActive false 150 && pass "stopping the cast reports SharingActive false" \
  || fail "SharingActive stayed true after the cast stopped"

# 5. a fresh cast in keep mode captures the window again, so the hide state
#    does not leak into the next share.
sleep 1
BASE_NODES="$(video_nodes)"
if start_cast "$BASE_NODES"; then
  gsettings --schemadir "$SCHEMADIR" set org.gnome.shell.extensions.osmos-bridge mode "'keep'"
  sleep 1
  if capture "$TMP/restored.png"; then
    back_px="$(magenta "$TMP/restored.png")"
    [ "$back_px" -gt 100 ] && pass "window is capturable again after the share (magenta px=$back_px)" \
      || fail "window did not return after the share (magenta px=$back_px)"
  else
    fail "could not capture the ScreenCast stream (restore check)"
  fi
  gsettings --schemadir "$SCHEMADIR" set org.gnome.shell.extensions.osmos-bridge mode "'hide'"
else
  fail "could not start the restore-check cast"
fi
stop_cast

grep -q "SharingChanged" "$TMP/monitor.log" && pass "SharingChanged signal emitted" \
  || fail "SharingChanged signal not seen"

gsettings --schemadir "$SCHEMADIR" set org.gnome.shell.extensions.osmos-bridge mode "'$ORIGINAL_MODE'" 2>/dev/null || true
kill "$MON_PID" 2>/dev/null || true
kill "$WIN_PID" 2>/dev/null || true

echo "--- extension log ---"
grep -E '\[osmos-bridge\]' "$LOG" || true
echo "--- shell warnings mentioning osmos ---"
grep -iE 'osmos.*(error|exception|warning)' "$LOG" || true

exit "$FAILS"
OUTER
status=$?
if [ "$status" -ne 0 ]; then
  echo "LIVE TEST FAILED (status $status)"
  exit "$status"
fi
echo "LIVE TEST PASS"
