"""
Linux-specific audio device management using PulseAudio/PipeWire.
Implements interface to get input and output devices on Linux.
"""

import subprocess
import platform
from typing import Dict, List, Any
from .base_platform import PlatformInterface

class LinuxAudioDeviceManager(PlatformInterface):
    """Linux audio device manager using PulseAudio/PipeWire"""
    
    def __init__(self):
        self.is_linux = platform.system() == "linux"
        self.pulse_available = self._check_pulse_availability()
        self.pipewire_available = self._check_pipewire_availability()
    
    def _check_pulse_availability(self) -> bool:
        """Check if PulseAudio is available"""
        try:
            subprocess.run(
                ["pactl", "--version"],
                capture_output=True,
                check=False
            )
            return True
        except (subprocess.SubprocessError, FileNotFoundError):
            return False
    
    def _check_pipewire_availability(self) -> bool:
        """Check if PipeWire is available"""
        try:
            subprocess.run(
                ["pw-cli", "info"],
                capture_output=True,
                check=False
            )
            return True
        except (subprocess.SubprocessError, FileNotFoundError):
            return False
    
    def get_devices(self) -> Dict[str, List[Dict[str, Any]]]:
        """Get Linux audio devices using pactl/PipeWire"""
        if not self.is_linux:
            return {"inputs": [], "outputs": []}
        
        devices = {"inputs": [], "outputs": []}
        
        # Try pactl first (PulseAudio/PipeWire)
        if self.pulse_available:
            devices.update(self._get_pactl_devices())
        elif self.pipewire_available:
            devices.update(self._get_pipewire_devices())
        
        return devices
    
    def _get_pactl_devices(self) -> Dict[str, List[Dict[str, Any]]]:
        """Get devices using pactl command"""
        devices = {"inputs": [], "outputs": []}
        
        try:
            # Get sources (inputs/microphones)
            sources = self._run_pactl_command(["list", "sources", "short"])
            for line in sources.strip().split('\n'):
                if '|' in line:
                    device_id, name = line.split('|', 1)
                    if '.monitor' not in device_id:  # Filter out monitor devices
                        devices["inputs"].append({
                            "id": device_id.strip(),
                            "name": name.strip(),
                            "type": "microphone",
                            "platform": "linux"
                        })
            
            # Get sinks (outputs/speakers)
            sinks = self._run_pactl_command(["list", "sinks", "short"])
            for line in sinks.strip().split('\n'):
                if '|' in line:
                    device_id, name = line.split('|', 1)
                    devices["outputs"].append({
                        "id": device_id.strip(),
                        "name": name.strip(),
                        "type": "speaker",
                        "platform": "linux"
                    })
        
        except Exception as e:
            print(f"Error getting PulseAudio devices: {e}")
        
        return devices
    
    def _get_pipewire_devices(self) -> Dict[str, List[Dict[str, Any]]]:
        """Get devices using PipeWire"""
        devices = {"inputs": [], "outputs": []}
        
        try:
            # Use pw-cli to get devices
            result = subprocess.run(
                ["pw-cli", "list", "nodes"],
                capture_output=True,
                text=True,
                timeout=10
            )
            
            for line in result.stdout.strip().split('\n'):
                if '|' in line:
                    props = dict(item.split('=', 1) for item in line.split('|') if '=' in item)
                    if 'node.id' in props and 'node.name' in props:
                        node_id = props['node.id']
                        node_name = props['node.name']
                        
                        # Determine if it's input or output based on node type
                        if 'monitor' in node_id.lower():
                            # Speaker output
                            devices["outputs"].append({
                                "id": node_id,
                                "name": node_name,
                                "type": "speaker",
                                "platform": "linux"
                            })
                        else:
                            # Microphone input
                            devices["inputs"].append({
                                "id": node_id,
                                "name": node_name,
                                "type": "microphone",
                                "platform": "linux"
                            })
        
        except Exception as e:
            print(f"Error getting PipeWire devices: {e}")
        
        return devices
    
    def _run_pactl_command(self, args: List[str]) -> str:
        """Run pactl command and return output"""
        try:
            result = subprocess.run(
                ["pactl"] + args,
                capture_output=True,
                text=True,
                timeout=10
            )
            if result.returncode != 0:
                raise subprocess.SubprocessError(f"pactl failed: {result.stderr}")
            return result.stdout
        except subprocess.TimeoutExpired:
            raise Exception("pactl command timed out")
        except Exception as e:
            raise Exception(f"pactl command failed: {e}")
    
    def get_defaults(self) -> Dict[str, str]:
        """Get default Linux audio devices"""
        defaults = {"input": "default", "output": "default"}
        
        try:
            # Get default source (input)
            source_result = subprocess.run(
                ["pactl", "get-default-source"],
                capture_output=True,
                text=True,
                check=False
            )
            if source_result.returncode == 0:
                defaults["input"] = source_result.stdout.strip()
            
            # Get default sink (output)
            sink_result = subprocess.run(
                ["pactl", "get-default-sink"],
                capture_output=True,
                text=True,
                check=False
            )
            if sink_result.returncode == 0:
                defaults["output"] = sink_result.stdout.strip()
        
        except Exception as e:
            print(f"Error getting Linux defaults: {e}")
        
        return defaults
    
    def get_device_info(self, device_id: str) -> Any:
        """Get detailed information about a Linux device"""
        return {
            "id": device_id,
            "name": device_id,  # In real implementation, query actual name
            "platform": "linux",
            "capabilities": ["input", "output"],
            "sample_rates": [44100, 48000],
            "channel_counts": [1, 2]
        }
