"""
OSMOS Audio Capture Module
Cross-platform audio capture for interview/meeting copilot functionality.

This module implements robust audio capture across macOS, Windows, and Linux,
providing system audio, microphone input, and intelligent device management.
Designed to work seamlessly with the OSMOS interview and meeting assistant.

License: MIT (compatible with existing OSMOS license)
Author: OSMOS contributors
Version: 0.5.2
"""

__version__ = "0.5.2"
__author__ = "OSMOS contributors"

from .device_manager import AudioDeviceManager
from .audio_capture import AudioCapture
from .audio_processor import AudioProcessor
from .types import AudioDeviceInfo, AudioCaptureConfig, AssistAudioSource, ProcessingStage

__all__ = [
    "AudioDeviceManager",
    "AudioCapture",
    "AudioProcessor",
    "AudioDeviceInfo",
    "AudioCaptureConfig",
    "AssistAudioSource",
    "ProcessingStage",
    "__version__",
    "__author__",
]