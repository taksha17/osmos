#!/usr/bin/env bash
# Verify that the OSMOS overlay canary does (or does not) appear in a recording.
#
#   verify-capture.sh recording.webm [fps] [canary]
#   verify-capture.sh --selftest [fps]
#
# OCR uses a system `tesseract` when present, otherwise OSMOS's bundled
# tesseract.js through `scripts/ocr-canary.mjs` (no apt install needed).
#
# Run BOTH cases in the real test: `mode=hide` must pass, and `mode=keep` must
# fail. --selftest proves the harness itself can see a leak and does not invent
# one — if the self-test fails, do not trust any PASS from this script.
set -uo pipefail

CANARY="OSMOS-CANARY-7F3A"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
FPS_DEFAULT=5

die() {
  echo "$*" >&2
  exit 2
}

need_ffmpeg() {
  command -v ffmpeg >/dev/null 2>&1 || die "ffmpeg is required"
}

font_path() {
  local f
  for f in \
    /usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf \
    /usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf \
    /usr/share/fonts/TTF/DejaVuSans-Bold.ttf; do
    if [ -f "$f" ]; then
      printf '%s\n' "$f"
      return 0
    fi
  done
  if command -v fc-match >/dev/null 2>&1; then
    fc-match -f '%{file}' 'sans:bold' 2>/dev/null | head -1
  fi
}

ocr_frames() {
  local dir="$1" total=0 hits=0 f needle
  if command -v tesseract >/dev/null 2>&1; then
    needle="$(printf '%s' "$CANARY" | tr -d ' ')"
    for f in "$dir"/f_*.png; do
      [ -e "$f" ] || continue
      total=$((total + 1))
      if tesseract "$f" - --psm 6 2>/dev/null | tr -d ' \n' | grep -qi "$needle"; then
        hits=$((hits + 1))
        echo "LEAK frame: $(basename "$f")"
      fi
    done
    echo "frames=$total canary_hits=$hits"
    [ "$hits" -eq 0 ]
    return $?
  fi

  command -v node >/dev/null 2>&1 ||
    die "Need tesseract or node (for OSMOS's bundled tesseract.js)"
  [ -f "$ROOT/scripts/ocr-canary.mjs" ] || die "scripts/ocr-canary.mjs not found"
  node "$ROOT/scripts/ocr-canary.mjs" "$dir" "$CANARY"
}

run_check() {
  local video="$1" fps="${2:-$FPS_DEFAULT}" dir="$TMP/frames"
  rm -rf "$dir"
  mkdir -p "$dir"
  ffmpeg -loglevel error -i "$video" -vf "fps=$fps" "$dir/f_%05d.png" ||
    die "ffmpeg could not read $video"
  ocr_frames "$dir"
}

make_video() {
  local out="$1" text="$2" font="$3"
  ffmpeg -loglevel error -f lavfi -i "color=c=0x1c1c1c:s=960x200:d=2:r=10" \
    -vf "drawtext=fontfile=$font:text='$text':fontcolor=white:fontsize=54:x=30:y=70" \
    -c:v mpeg4 -pix_fmt yuv420p -y "$out"
}

selftest() {
  need_ffmpeg
  local fps="${1:-2}" font leak clean status
  font="$(font_path)"
  [ -n "$font" ] || die "No bold font found for the self-test title text"

  leak="$TMP/leak.mp4"
  clean="$TMP/clean.mp4"
  make_video "$leak" "$CANARY" "$font" || die "Could not generate the leaking test video"
  make_video "$clean" "Nothing to see here" "$font" || die "Could not generate the clean test video"

  echo "selftest: a recording containing the canary must be flagged"
  run_check "$leak" "$fps"
  status=$?
  if [ "$status" -ne 1 ]; then
    echo "SELFTEST FAIL: harness did not find the canary (exit $status)" >&2
    return 1
  fi

  echo "selftest: a clean recording must pass"
  run_check "$clean" "$fps"
  status=$?
  if [ "$status" -ne 0 ]; then
    echo "SELFTEST FAIL: harness reported a false leak (exit $status)" >&2
    return 1
  fi

  echo "SELFTEST PASS: leak detection works and the clean control is clean"
}

if [ "${1:-}" = "--selftest" ]; then
  selftest "${2:-2}"
  exit $?
fi

VIDEO="${1:-}"
[ -n "$VIDEO" ] || die "Usage: verify-capture.sh recording.webm [fps] [canary]  |  --selftest [fps]"
[ -f "$VIDEO" ] || die "No such recording: $VIDEO"
[ -n "${3:-}" ] && CANARY="$3"
need_ffmpeg

run_check "$VIDEO" "${2:-$FPS_DEFAULT}"
status=$?
if [ "$status" -eq 0 ]; then
  echo "PASS: canary not found"
elif [ "$status" -eq 1 ]; then
  echo "FAIL: canary visible"
else
  echo "FAIL: verification could not run (exit $status)"
fi
[ "$status" -eq 0 ]
