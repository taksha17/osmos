"""
Cross-platform audio capture for interview/meeting copilot functionality.
Provides system audio, microphone input, and intelligent device management.
"""

import asyncio
import threading
from typing import Optional, Callable, AsyncIterator, Dict, Any
from dataclasses import dataclass
from .device_manager import AudioDeviceManager
from .audio_processor import AudioProcessor
from .types import AssistAudioSource

@dataclass
class AudioCaptureConfig:
    """Configuration for audio capture"""
    sample_rate: int = 16000
    channels: int = 1
    bit_depth: int = 16
    device_id: Optional[str] = None
    format: str = 'wav'
    auto_reconnect: bool = True
    reconnect_delay: float = 1.0
    audio_source: str = 'system'  # 'system', 'mic', 'both'

class AudioCapture:
    """Cross-platform audio capture for OSMOS"""
    
    def __init__(self, config: AudioCaptureConfig, audio_source: str = 'system'):
        self.config = config
        self.config.audio_source = audio_source  # Ensure audio_source is set
        self.device_manager = AudioDeviceManager()
        self.processor = AudioProcessor(config.sample_rate)
        self.is_capturing = False
        self.capture_thread: Optional[threading.Thread] = None
        self.audio_stream: Optional[AsyncIterator[bytes]] = None
        
    async def start_capture(
        self,
        audio_callback: Callable[[bytes], None],
        error_callback: Optional[Callable[[Exception], None]] = None
    ):
        """Start audio capture"""
        try:
            self.is_capturing = True
            self.audio_stream = self._get_platform_backend().capture(
                self.config, audio_callback, error_callback
            )
            
            # Start capture in background thread
            self.capture_thread = threading.Thread(
                target=self._capture_loop,
                args=(audio_callback, error_callback),
                daemon=True
            )
            self.capture_thread.start()
            
        except Exception as e:
            self.is_capturing = False
            if error_callback:
                error_callback(e)
            raise
    
    def _get_platform_backend(self):
        """Get platform-specific audio backend"""
        # Import here to avoid circular imports
        from .macos_capture import MacAudioCapture
        from .windows_capture import WindowsAudioCapture
        from .linux_capture import LinuxAudioCapture
        
        platform = self._get_platform()
        platform_backends = {
            "macos": MacAudioCapture(),
            "windows": WindowsAudioCapture(),
            "linux": LinuxAudioCapture(),
        }
        return platform_backends[platform]
    
    def _get_platform(self) -> str:
        """Detect current platform"""
        import sys
        if sys.platform == "darwin":
            return "macos"
        elif sys.platform == "win32":
            return "windows"
        elif sys.platform.startswith("linux"):
            return "linux"
        else:
            raise NotImplementedError(f"Unsupported platform: {sys.platform}")
    
    async def _capture_loop(self, 
                           audio_callback: Callable[[bytes], None],
                           error_callback: Optional[Callable[[Exception], None]] = None):
        """Main capture loop"""
        try:
            async for audio_data in self.audio_stream or []:
                try:
                    audio_callback(audio_data)
                except Exception as e:
                    if error_callback:
                        error_callback(e)
        except Exception as e:
            if error_callback:
                error_callback(e)
        finally:
            self.is_capturing = False
    
    async def stop_capture(self):
        """Stop audio capture"""
        self.is_capturing = False
        if self.capture_thread:
            self.capture_thread.join(timeout=5.0)
            self.capture_thread = None
        self.audio_stream = None
    
    def get_available_devices(self):
        """Get available audio devices"""
        return self.device_manager.get_available_devices()
    
    async def list_available_devices(self):
        """Get available audio devices (async version)"""
        devices = self.get_available_devices()
        return {
            "inputs": devices.get("inputs", []),
            "outputs": devices.get("outputs", []),
        }
