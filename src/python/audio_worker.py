#!/usr/bin/env python3
"""
OSMOS Python Audio Worker
Standalone Python process that handles audio capture and communication via stdin/stdout
Designed to be spawned from Electron main process, similar to whisper-worker.mjs
"""

import asyncio
import json
import sys
import os
from typing import Dict, Any, Optional
from audio import AudioCapture, AudioCaptureConfig, AssistAudioSource
from audio.types import ProcessedAudioChunk
import numpy as np
import base64


class AudioWorker:
    def __init__(self):
        self.capture: Optional[AudioCapture] = None
        self.is_capturing = False
        self.loop = asyncio.get_event_loop()
        
    async def initialize(self):
        """Initialize the audio worker"""
        # Nothing special needed for initialization
        pass
    
    async def handle_message(self, message: Dict[str, Any]) -> Dict[str, Any]:
        """Handle incoming JSON message from stdin"""
        command = message.get("command")
        
        try:
            if command == "initialize":
                return await self._handle_initialize(message)
            elif command == "list_devices":
                return await self._handle_list_devices(message)
            elif command == "start_capture":
                return await self._handle_start_capture(message)
            elif command == "stop_capture":
                return await self._handle_stop_capture(message)
            elif command == "get_device_info":
                return await self._handle_get_device_info(message)
            else:
                return {"ok": False, "error": f"Unknown command: {command}"}
        except Exception as e:
            return {"ok": False, "error": str(e)}
    
    async def _handle_initialize(self, message: Dict[str, Any]) -> Dict[str, Any]:
        """Initialize the audio capture system"""
        return {"ok": True}
    
    async def _handle_list_devices(self, message: Dict[str, Any]) -> Dict[str, Any]:
        """List available audio devices"""
        capture = AudioCapture(AudioCaptureConfig())
        devices = capture.get_available_devices()
        
        # Convert to serializable format
        return {
            "ok": True,
            "inputs": [
                {
                    "id": device["id"],
                    "name": device["name"],
                    "type": device["type"],
                    "platform": device["platform"],
                    "capabilities": device["capabilities"],
                    "sample_rates": device["sample_rates"],
                    "channel_counts": device["channel_counts"],
                    "is_default": device.get("is_default", False)
                }
                for device in devices.get("inputs", [])
            ],
            "outputs": [
                {
                    "id": device["id"],
                    "name": device["name"],
                    "type": device["type"],
                    "platform": device["platform"],
                    "capabilities": device["capabilities"],
                    "sample_rates": device["sample_rates"],
                    "channel_counts": device["channel_counts"],
                    "is_default": device.get("is_default", False)
                }
                for device in devices.get("outputs", [])
            ],
            "preferredInputId": capture.device_manager.get_default_devices().get("input", ""),
            "preferredOutputId": capture.device_manager.get_default_devices().get("output", "")
        }
    
    async def _handle_start_capture(self, message: Dict[str, Any]) -> Dict[str, Any]:
        """Start audio capture"""
        if self.is_capturing:
            return {"ok": False, "error": "Already capturing"}
        
        # Parse configuration
        config_data = message.get("config", {})
        config = AudioCaptureConfig(
            sample_rate=config_data.get("sample_rate", 16000),
            channels=config_data.get("channels", 1),
            bit_depth=config_data.get("bit_depth", 16),
            device_id=config_data.get("device_id"),
            format=config_data.get("format", "wav"),
            auto_reconnect=config_data.get("auto_reconnect", True),
            reconnect_delay=config_data.get("reconnect_delay", 1.0),
        )
        # Set audio_source as attribute after construction (to avoid dataclass __init__ issues)
        config.audio_source = config_data.get("audio_source", "system")  # system, mic, both
        
        # Convert audio_source string to enum
        audio_source_map = {
            "system": AssistAudioSource.SYSTEM,
            "mic": AssistAudioSource.MIC,
            "both": AssistAudioSource.BOTH
        }
        config.audio_source = audio_source_map.get(config.audio_source, AssistAudioSource.SYSTEM)
        
        self.capture = AudioCapture(config, config.audio_source)
        
        # Set up callbacks
        audio_chunks = []
        
        def audio_callback(audio_data: bytes):
            # Convert to base64 for JSON transmission
            audio_chunks.append({
                "data": base64.b64encode(audio_data).decode('utf-8'),
                "timestamp": asyncio.get_event_loop().time(),
                "sample_rate": config.sample_rate,
                "channels": config.channels
            })
        
        def error_callback(error: Exception):
            # Send error back via the worker's stdout
            error_msg = {
                "ok": False,
                "error": str(error),
                "type": "capture_error"
            }
            # We'd need a way to send this - for now we'll just log it
            print(json.dumps(error_msg), flush=True)
        
        # Start capture in background
        async def capture_task():
            try:
                await self.capture.start_capture(audio_callback, error_callback)
                self.is_capturing = True
            except Exception as e:
                self.is_capturing = False
                error_msg = {
                    "ok": False,
                    "error": str(e),
                    "type": "capture_error"
                }
                print(json.dumps(error_msg), flush=True)
        
        # Start the capture task
        asyncio.create_task(capture_task())
        
        # Return immediately - audio will come via notifications
        return {"ok": True, "message": "Capture started"}
    
    async def _handle_stop_capture(self, message: Dict[str, Any]) -> Dict[str, Any]:
        """Stop audio capture"""
        if not self.is_capturing or not self.capture:
            return {"ok": False, "error": "Not capturing"}
        
        try:
            await self.capture.stop_capture()
            self.is_capturing = False
            self.capture = None
            return {"ok": True}
        except Exception as e:
            return {"ok": False, "error": str(e)}
    
    async def _handle_get_device_info(self, message: Dict[str, Any]) -> Dict[str, Any]:
        """Get information about a specific device"""
        device_id = message.get("device_id")
        if not device_id:
            return {"ok": False, "error": "device_id required"}
        
        capture = AudioCapture(AudioCaptureConfig())
        try:
            device_info = capture.device_manager.get_device_info(device_id)
            return {"ok": True, "device_info": device_info}
        except Exception as e:
            return {"ok": False, "error": str(e)}


async def main():
    """Main worker loop"""
    worker = AudioWorker()
    await worker.initialize()
    
    # Send ready signal
    print(json.dumps({"ok": True, "ready": True}), flush=True)
    
    # Read commands from stdin
    while True:
        try:
            line = await asyncio.get_event_loop().run_in_executor(
                None, sys.stdin.readline
            )
            
            if not line:
                break
                
            line = line.strip()
            if not line:
                continue
                
            try:
                message = json.loads(line)
                response = await worker.handle_message(message)
                print(json.dumps(response), flush=True)
            except json.JSONDecodeError as e:
                error_response = {
                    "ok": False,
                    "error": f"Invalid JSON: {str(e)}"
                }
                print(json.dumps(error_response), flush=True)
                
        except EOFError:
            break
        except Exception as e:
            error_response = {
                "ok": False,
                "error": f"Worker error: {str(e)}"
            }
            print(json.dumps(error_response), flush=True)


if __name__ == "__main__":
    asyncio.run(main())