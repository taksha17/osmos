#!/usr/bin/env python3
"""
OSMOS Screen Worker — GNOME Mutter ScreenCast → JPEG frames (Linux/Wayland).

Reads the monitor via `org.gnome.Mutter.ScreenCast` (the compositor-level API
the xdg-desktop-portal uses internally) and a GStreamer `pipewiresrc` pipeline.
This grabs frames with **no permission dialog and no screen flash** — unlike the
portal (dialog) or `gnome-screenshot` (visible flash). It is the preferred
background screen-reading backend on GNOME Wayland.

Protocol (newline-delimited JSON, like audio_worker.py / whisper-worker.mjs):
  stdout: {"ready": true}                              once at startup
  stdin : {"command": "start", "intervalMs": 2000, "width": 1440}
  stdin : {"command": "stop"}
  stdout: {"frame": "<base64 jpeg>", "at": <ms>, "w": W, "h": H}   per changed frame
  stdout: {"status": "..."} | {"stopped": true} | {"error": "..."}

Requires system python3-gi + GStreamer (default on Ubuntu GNOME). We spawn
system `python3`; nothing is bundled, so this backend is only offered when the
imports and Mutter D-Bus are actually present.
"""

import sys
import json
import time
import base64
import threading

try:
    import gi
    gi.require_version("Gst", "1.0")
    gi.require_version("Gio", "2.0")
    gi.require_version("GLib", "2.0")
    from gi.repository import Gst, Gio, GLib
except Exception as e:  # pragma: no cover - environment probe
    print(json.dumps({"error": f"python gi/GStreamer unavailable: {e}"}), flush=True)
    sys.exit(1)

SC = "org.gnome.Mutter.ScreenCast"


def emit(obj):
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


class MutterScreenCast:
    def __init__(self):
        Gst.init(None)
        self.bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
        self.session_path = None
        self.pipeline = None
        self.jpg_sink = None
        self.node_id = None
        self.running = False
        self.thread = None
        self._prev_jpeg = None

    # ── D-Bus helpers ────────────────────────────────────────────────
    def _call(self, path, iface, method, params, reply_type):
        return self.bus.call_sync(
            SC, path, iface, method, params, reply_type,
            Gio.DBusCallFlags.NONE, 5000, None,
        )

    def _primary_geometry(self):
        """Physical pixel rect + connector for the primary monitor.

        Used to RecordArea a *content* crop (skip GNOME panel + browser tab
        strip) so OCR sees the page/slide, not every open tab title.
        """
        res = self.bus.call_sync(
            "org.gnome.Mutter.DisplayConfig", "/org/gnome/Mutter/DisplayConfig",
            "org.gnome.Mutter.DisplayConfig", "GetCurrentState", None, None,
            Gio.DBusCallFlags.NONE, 5000, None,
        ).unpack()
        _serial, monitors, logical, _props = res
        connector = None
        lx = ly = 0
        scale = 1.0
        for lm in logical:
            try:
                x, y, sc, _transform, primary, mons = lm[0], lm[1], lm[2], lm[3], lm[4], lm[5]
            except Exception:
                continue
            if not primary:
                continue
            lx, ly, scale = int(x), int(y), float(sc or 1)
            if mons:
                first = mons[0]
                connector = first[0] if isinstance(first, (list, tuple)) else first
            break
        if not connector and monitors:
            spec = monitors[0][0]
            connector = spec[0] if isinstance(spec, (list, tuple)) else spec
        width = height = None
        for mon in monitors:
            spec = mon[0] if mon and isinstance(mon[0], (list, tuple)) else mon
            conn = spec[0] if isinstance(spec, (list, tuple)) else spec
            if connector and conn != connector:
                continue
            modes = None
            for part in mon:
                if isinstance(part, (list, tuple)) and part and isinstance(part[0], (list, tuple)):
                    modes = part
                    break
            if not modes:
                continue
            for mode in modes:
                try:
                    mw, mh = int(mode[1]), int(mode[2])
                except Exception:
                    continue
                props = mode[-1] if mode and isinstance(mode[-1], dict) else {}
                if props.get("is-current") or width is None:
                    width, height = mw, mh
                    if props.get("is-current"):
                        break
        return {
            "connector": connector,
            "x": int(lx * scale),
            "y": int(ly * scale),
            "w": width,
            "h": height,
        }

    def _open_stream(self, geom):
        """Prefer RecordArea of the content region (no panel / tab strip)."""
        props = {"cursor-mode": GLib.Variant("u", 0)}
        connector = geom.get("connector")
        w, h = geom.get("w"), geom.get("h")
        if w and h and w >= 640 and h >= 400:
            top = int(h * 0.12)  # panel + title + browser tabs
            bot = int(h * 0.04)
            ax, ay = int(geom["x"]), int(geom["y"]) + top
            aw, ah = int(w), int(h - top - bot)
            try:
                path = self._call(
                    self.session_path, SC + ".Session", "RecordArea",
                    GLib.Variant("(iiiia{sv})", [ax, ay, aw, ah, props]),
                    GLib.VariantType("(o)"),
                ).unpack()[0]
                return path, f"area {aw}x{ah}+{ax}+{ay}", aw, ah
            except Exception as e:
                emit({"status": f"RecordArea unavailable ({e}); using full monitor"})
        if not connector:
            raise RuntimeError("No monitor connector from Mutter.DisplayConfig")
        path = self._call(
            self.session_path, SC + ".Session", "RecordMonitor",
            GLib.Variant("(sa{sv})", [connector, props]),
            GLib.VariantType("(o)"),
        ).unpack()[0]
        return path, f"monitor {connector}", w, h

    # ── lifecycle ────────────────────────────────────────────────────
    def start(self, interval_ms, width):
        if self.running:
            return
        geom = self._primary_geometry()
        if not geom.get("connector") and not (geom.get("w") and geom.get("h")):
            emit({"error": "No monitor connector from Mutter.DisplayConfig"})
            return

        self.session_path = self._call(
            "/org/gnome/Mutter/ScreenCast", SC, "CreateSession",
            GLib.Variant("(a{sv})", [{}]), GLib.VariantType("(o)"),
        ).unpack()[0]

        try:
            stream_path, how, src_w, src_h = self._open_stream(geom)
        except Exception as e:
            emit({"error": f"Mutter ScreenCast record failed: {e}"})
            self._stop_session()
            return

        # Wait for the PipeWire node id, then build the GStreamer pipeline.
        loop = GLib.MainLoop()
        holder = {}

        def on_signal(_c, _s, _p, _i, signal, params):
            if signal == "PipeWireStreamAdded":
                holder["node"] = params.unpack()[0]
                loop.quit()

        self.bus.signal_subscribe(
            SC, SC + ".Stream", "PipeWireStreamAdded", stream_path, None,
            Gio.DBusSignalFlags.NONE, on_signal,
        )
        self._call(self.session_path, SC + ".Session", "Start", None, None)
        GLib.timeout_add(5000, loop.quit)
        loop.run()
        if "node" not in holder:
            emit({"error": "Mutter ScreenCast produced no PipeWire node"})
            self._stop_session()
            return
        self.node_id = holder["node"]

        w = max(320, min(3840, int(width or 1440)))
        h_out = 0
        if src_w and src_h:
            h_out = max(180, int(src_h * w / src_w))
        size_caps = f"width={w},height={h_out}" if h_out else f"width={w}"
        # I420 into jpegenc keeps colours correct (feeding RGB tints the JPEG).
        # If we had to RecordMonitor (full desktop), crop the top ~11% so the
        # GNOME panel + browser tab strip never reach Tesseract.
        crop = ""
        if how.startswith("monitor") and Gst.ElementFactory.find("videocrop"):
            crop = "videocrop top=88 bottom=24 ! "
        desc = (
            f"pipewiresrc path={self.node_id} do-timestamp=true keepalive-time=1000 ! "
            f"videoconvert ! videoscale ! video/x-raw,format=I420,{size_caps} ! "
            f"{crop}"
            f"jpegenc quality=72 ! "
            f"appsink name=jpg max-buffers=1 drop=true sync=false"
        )
        self.pipeline = Gst.parse_launch(desc)
        self.jpg_sink = self.pipeline.get_by_name("jpg")
        self.pipeline.set_state(Gst.State.PLAYING)
        # Block until PLAYING so the first pull isn't racing preroll.
        self.pipeline.get_state(3 * Gst.SECOND)

        self.running = True
        self.thread = threading.Thread(
            target=self._loop, args=(max(500, int(interval_ms or 2000)),), daemon=True
        )
        self.thread.start()
        emit({"status": f"mutter-screencast {how} node={self.node_id} {w}px"})

    def _grab_jpeg(self):
        smp = self.jpg_sink.emit("try-pull-sample", int(3 * Gst.SECOND))
        if smp is None:
            return None
        buf = smp.get_buffer()
        ok, mi = buf.map(Gst.MapFlags.READ)
        if not ok:
            return None
        data = bytes(mi.data)
        buf.unmap(mi)
        caps = smp.get_caps().get_structure(0)
        return data, caps.get_value("width"), caps.get_value("height")

    def _loop(self, interval_ms):
        interval = interval_ms / 1000.0
        while self.running:
            try:
                grabbed = self._grab_jpeg()
                if grabbed:
                    data, w, h = grabbed
                    # Skip byte-identical frames (fully static screen). Any real
                    # change reshuffles JPEG bytes; downstream OCR also perceptual
                    # -hash dedupes, so near-identical frames are cheap there.
                    if data != self._prev_jpeg:
                        self._prev_jpeg = data
                        emit({
                            "frame": base64.b64encode(data).decode("ascii"),
                            "at": int(time.time() * 1000),
                            "w": w, "h": h,
                        })
            except Exception as e:  # keep the loop alive on transient errors
                emit({"status": f"frame error: {e}"})
            time.sleep(interval)

    def _stop_session(self):
        if self.session_path:
            try:
                self._call(self.session_path, SC + ".Session", "Stop", None, None)
            except Exception:
                pass
            self.session_path = None

    def stop(self):
        had_session = bool(self.pipeline or self.session_path)
        self.running = False
        if self.thread:
            self.thread.join(timeout=2)
            self.thread = None
        if self.pipeline:
            try:
                self.pipeline.set_state(Gst.State.NULL)
            except Exception:
                pass
            self.pipeline = None
        self._stop_session()
        self._prev_jpeg = None
        if had_session:
            emit({"stopped": True})


def probe():
    """Fast capability check: gi/GStreamer import (already done above) plus a
    live Mutter ScreenCast D-Bus name owner. Prints one JSON line, exits."""
    try:
        Gst.init(None)  # populate the plugin registry before find()
        bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
        owned = bus.call_sync(
            "org.freedesktop.DBus", "/org/freedesktop/DBus",
            "org.freedesktop.DBus", "NameHasOwner",
            GLib.Variant("(s)", [SC]), GLib.VariantType("(b)"),
            Gio.DBusCallFlags.NONE, 3000, None,
        ).unpack()[0]
        if not owned:
            emit({"ok": False, "error": "org.gnome.Mutter.ScreenCast not available"})
        elif not Gst.ElementFactory.find("pipewiresrc"):
            emit({"ok": False, "error": "GStreamer pipewiresrc plugin missing"})
        else:
            emit({"ok": True})
    except Exception as e:
        emit({"ok": False, "error": str(e)})


def main():
    if len(sys.argv) > 1 and sys.argv[1] == "probe":
        probe()
        return
    cast = MutterScreenCast()
    emit({"ready": True})
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except json.JSONDecodeError:
            continue
        cmd = msg.get("command")
        if cmd == "start":
            try:
                cast.start(msg.get("intervalMs", 2000), msg.get("width", 1440))
            except Exception as e:
                emit({"error": f"start failed: {e}"})
        elif cmd == "stop":
            cast.stop()
        elif cmd == "quit":
            cast.stop()
            break
    cast.stop()


if __name__ == "__main__":
    main()
