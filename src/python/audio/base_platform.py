"""
Base interface for platform-specific audio device management.
Defines the contract for platform-specific implementations.
"""

from typing import Dict, List, Any
from abc import ABC, abstractmethod

class PlatformInterface(ABC):
    """Abstract base class for platform-specific audio device management"""
    
    @abstractmethod
    def get_devices(self) -> Dict[str, List[Dict[str, Any]]]:
        """Get all available audio devices
        
        Returns:
            Dict with keys 'inputs' and 'outputs' containing device lists
        """
        pass
    
    @abstractmethod
    def get_defaults(self) -> Dict[str, str]:
        """Get default device IDs
        
        Returns:
            Dict with keys 'input' and 'output' containing default device IDs
        """
        pass
    
    @abstractmethod
    def get_device_info(self, device_id: str) -> Any:
        """Get detailed information about a specific device
        
        Args:
            device_id: The ID of the device to get info for
            
        Returns:
            Device information object
        """
        pass
