/**
 * Fatal audio failures — when restarting capture cannot help.
 *
 * Smart's watchdog restarts a failed ear. That is right for a device that was
 * unplugged and plugged back in, and wrong for a missing virtual cable, a denied
 * OS permission or a missing playback endpoint: every retry fails the same way
 * and the UI keeps claiming to listen.
 *
 * One classifier for every platform so the Linux monitor path, Windows Chromium
 * loopback and macOS BlackHole path all stop honestly instead of retrying.
 */

/** True for system-audio errors that need a user fix, not another capture. */
export function isFatalSystemAudioError(message: string): boolean {
  return [
    // Windows: no active render endpoint / capture denied / no audio track.
    /no active playback device/i,
    /no audio track/i,
    /desktop capture was blocked/i,
    // macOS: BlackHole (or another virtual cable) is missing.
    /macos meeting audio needs a virtual loopback/i,
    /blackhole/i,
    // Linux: the default sink has no monitor source.
    /no sink monitor found/i,
    // The platform adapter exhausted every backend it has.
    /system audio capture failed/i,
  ].some((re) => re.test(message));
}

/** True for microphone errors that need a user fix, not another restart. */
export function isFatalMicError(message: string): boolean {
  return [
    // No capture device on any platform.
    /no directshow microphones/i,
    /no avfoundation audio inputs/i,
    /no usable microphone/i,
    /no microphone/i,
    /no default source/i,
    /no such device/i,
    /device not found/i,
    /cannot open audio device/i,
    /no laptop/i,
    // Permissions and plumbing a restart cannot repair.
    /grant microphone permission/i,
    /main-process mic streaming unavailable/i,
    /continuous mic streaming is not supported/i,
    /ffmpeg (is|was) (present|not found|required)/i,
    /will not run/i,
    /blocked by device policy/i,
    /needs linux build/i,
    /mic backend not resolved/i,
  ].some((re) => re.test(message));
}
