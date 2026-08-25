"""
Type definitions for OSMOS audio processing pipeline.
Defines data structures and enums for audio processing components.
"""

import numpy as np
from typing import Optional, Dict, Any, List
from enum import Enum
from dataclasses import dataclass


class AssistAudioSource(Enum):
    """Audio source for capture"""
    SYSTEM = "system"
    MIC = "mic"
    BOTH = "both"

class ProcessingStage(Enum):
    """Stages in the audio processing pipeline"""
    RAW_CAPTURE = "raw_capture"
    RESAMPLING = "resampling"
    VAD = "voice_activity_detection"
    SILENCE_SUPPRESSION = "silence_suppression"
    BATCHING = "batching"
    OUTPUT = "output"

@dataclass
class AudioBuffer:
    """Circular buffer for audio processing"""
    data: np.ndarray
    start_index: int
    end_index: int
    capacity: int
    sample_rate: int
    
    def is_full(self) -> bool:
        return (self.end_index - self.start_index) >= self.capacity
    
    def is_empty(self) -> bool:
        return self.start_index >= self.end_index
    
    def available_samples(self) -> int:
        return self.end_index - self.start_index
    
    def get_samples(self, num_samples: int) -> np.ndarray:
        if num_samples <= 0:
            return np.array([])
        
        if self.available_samples() < num_samples:
            return np.array([])
        
        samples = self.data[self.start_index:self.start_index + num_samples]
        self.start_index += num_samples
        return samples

@dataclass
class AudioDeviceInfo:
    """Information about an audio device"""
    id: str
    name: str
    type: str
    platform: str
    capabilities: List[str]
    sample_rates: List[int]
    channel_counts: List[int]
    is_default: bool = False

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

@dataclass
class ProcessedAudioChunk:
    """Processed audio chunk with metadata"""
    data: np.ndarray
    sample_rate: int
    timestamp: float
    is_speech: bool
    confidence: float
    device_id: Optional[str] = None
