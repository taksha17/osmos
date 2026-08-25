"""
Audio device management for cross-platform audio capture.
Manages audio devices across macOS, Windows, and Linux platforms.
"""

from typing import Dict, List, Any
from .base_platform import PlatformInterface
from .macos_device_manager import MacAudioDeviceManager
from .windows_device_manager import WindowsAudioDeviceManager
from .linux_device_manager import LinuxAudioDeviceManager

class AudioDeviceManager:
    """Manages audio devices across all platforms"""
    
    def __init__(self):
        self.platform = self._get_platform()
        self._platform_manager = self._get_platform_manager()
    
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
    
    def _get_platform_manager(self):
        """Get platform-specific device manager"""
        platform_managers = {
            "macos": MacAudioDeviceManager(),
            "windows": WindowsAudioDeviceManager(),
            "linux": LinuxAudioDeviceManager(),
        }
        return platform_managers[self.platform]
    
    def get_available_devices(self) -> Dict[str, List[Dict[str, Any]]]:
        """Get all available audio devices"""
        return self._platform_manager.get_devices()
    
    def get_system_audio_devices(self) -> List[Dict[str, Any]]:
        """Get system audio output devices (speakers)"""
        devices = self.get_available_devices()
        return devices.get("outputs", [])
    
    def get_microphone_devices(self) -> List[Dict[str, Any]]:
        """Get microphone input devices"""
        devices = self.get_available_devices()
        return devices.get("inputs", [])
    
    def get_default_devices(self) -> Dict[str, str]:
        """Get default input and output device IDs"""
        return self._platform_manager.get_defaults()
    
    def get_device_info(self, device_id: str) -> Any:
        """Get detailed information about a specific device"""
        return self._platform_manager.get_device_info(device_id)
