"""
Audio processing pipeline for OSMOS.
Implements resampling, voice activity detection, and silence suppression
for efficient audio processing in interview/meeting copilot scenarios.
"""

import numpy as np
from typing import Optional, List, Tuple, Callable, Dict, Any
from dataclasses import dataclass
from enum import Enum

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

class Resampler:
    """High-quality audio resampler for converting between sample rates"""
    
    def __init__(self, target_sample_rate: int, source_sample_rate: int):
        self.target_sample_rate = target_sample_rate
        self.source_sample_rate = source_sample_rate
        self.ratio = target_sample_rate / source_sample_rate
        
        # Pre-calculate filter coefficients for efficient resampling
        self.filter_length = 8
        self.hamming_window = np.hamming(self.filter_length)
    
    def resample(self, audio_data: np.ndarray, source_sample_rate: int) -> np.ndarray:
        """Resample audio from source to target sample rate
        
        Args:
            audio_data: Input audio samples
            source_sample_rate: Sample rate of input audio
            
        Returns:
            Resampled audio at target sample rate
        """
        if source_sample_rate == self.target_sample_rate:
            return audio_data
        
        # Calculate output length
        output_length = int(len(audio_data) * self.ratio)
        
        # Use numpy's resample for high-quality resampling
        resampled = np.interp(
            np.linspace(0, len(audio_data) - 1, output_length),
            np.arange(len(audio_data)),
            audio_data.astype(float)
        )
        
        return resampled.astype(audio_data.dtype)
    
    def is_passthrough(self, source_sample_rate: int) -> bool:
        """Check if resampler can use passthrough (no resampling needed)"""
        return source_sample_rate == self.target_sample_rate

class VoiceActivityDetector:
    """WebRTC-style Voice Activity Detection"""
    
    def __init__(self, 
                 threshold_db: float = -30.0,
                 min_speech_duration_ms: float = 100.0,
                 max_silence_duration_ms: float = 500.0):
        self.threshold_db = threshold_db
        self.min_speech_duration_ms = min_speech_duration_ms
        self.max_silence_duration_ms = max_silence_duration_ms
        
        # Internal state
        self.speech_start_time: Optional[float] = None
        self.silence_start_time: Optional[float] = None
        self.current_state: str = "silence"  # "silence" or "speech"
        
        # Energy calculation parameters
        self.energy_history: List[float] = []
        self.energency_decay = 0.95
    
    def calculate_rms(self, audio_data: np.ndarray) -> float:
        """Calculate Root Mean Square (RMS) of audio data"""
        if len(audio_data) == 0:
            return 0.0
        return np.sqrt(np.mean(np.square(audio_data)))
    
    def calculate_db(self, rms: float) -> float:
        """Convert RMS to decibels"""
        if rms <= 0:
            return -float('inf')
        return 20 * np.log10(rms)
    
    def process_chunk(self, audio_chunk: np.ndarray, 
                     timestamp_ms: float) -> Tuple[str, bool]:
        """Process audio chunk and determine speech/silence state
        
        Args:
            audio_chunk: Audio samples
            timestamp_ms: Current timestamp in milliseconds
            
        Returns:
            Tuple of (current_state, speech_ended)
        """
        if len(audio_chunk) == 0:
            return self.current_state, False
        
        # Calculate audio energy
        rms = self.calculate_rms(audio_chunk)
        db_level = self.calculate_db(rms)
        
        # Determine if audio is speech or silence
        is_speech = db_level > self.threshold_db
        
        if is_speech:
            if self.current_state == "silence":
                self.speech_start_time = timestamp_ms
                self.silence_start_time = None
            self.current_state = "speech"
            return "speech", False
        else:
            if self.current_state == "speech":
                self.silence_start_time = timestamp_ms
                self.current_state = "silence"
                # Check if speech duration meets minimum threshold
                if (self.speech_start_time and 
                    (timestamp_ms - self.speech_start_time) >= self.min_speech_duration_ms):
                    return "silence", True  # Speech ended
            return "silence", False
    
    def get_speech_duration(self) -> float:
        """Get current speech duration in milliseconds"""
        if self.speech_start_time is None or self.silence_start_time is None:
            return 0.0
        return self.silence_start_time - self.speech_start_time

class SilenceSuppressor:
    """Silence suppression to reduce bandwidth usage"""
    
    def __init__(self, 
                 vad: VoiceActivityDetector,
                 min_speech_duration_ms: float = 100.0,
                 max_silence_duration_ms: float = 500.0):
        self.vad = vad
        self.min_speech_duration_ms = min_speech_duration_ms
        self.max_silence_duration_ms = max_silence_duration_ms
    
    def process_chunk(self, audio_chunk: np.ndarray, 
                     timestamp_ms: float) -> Tuple[str, bool]:
        """Process audio chunk with silence suppression
        
        Args:
            audio_chunk: Audio samples
            timestamp_ms: Current timestamp in milliseconds
            
        Returns:
            Tuple of (action, speech_ended)
            action: "send", "silence", or "suppress"
            speech_ended: Whether speech has ended
        """
        # Get VAD decision
        state, speech_ended = self.vad.process_chunk(audio_chunk, timestamp_ms)
        
        if state == "speech":
            speech_duration = self.vad.get_speech_duration()
            
            if speech_duration >= self.min_speech_duration_ms:
                return "send", speech_ended
            else:
                return "suppress", speech_ended
                
        elif state == "silence":
            silence_duration = self.vad.silence_start_time or 0
            
            if silence_duration >= self.max_silence_duration_ms:
                return "silence", speech_ended
            else:
                return "suppress", speech_ended
    
    def should_send_audio(self, action: str) -> bool:
        """Determine if audio should be sent based on action"""
        return action in ("send", "silence")

class AudioProcessingPipeline:
    """Complete audio processing pipeline for OSMOS"""
    
    def __init__(self, 
                 sample_rate: int = 16000,
                 target_sample_rate: int = 16000):
        self.sample_rate = sample_rate
        self.target_sample_rate = target_sample_rate
        
        # Pipeline components
        self.resampler = Resampler(target_sample_rate, sample_rate)
        self.vad = VoiceActivityDetector()
        self.silence_suppressor = SilenceSuppressor(
            self.vad,
            min_speech_duration_ms=100.0,
            max_silence_duration_ms=500.0
        )
        
        # State management
        self.is_running = False
        self.current_audio_buffer = AudioBuffer(
            data=np.zeros(8192, dtype=np.int16),
            start_index=0,
            end_index=0,
            capacity=8192,
            sample_rate=sample_rate
        )
        
        # Callbacks
        self.audio_callback: Optional[Callable[[np.ndarray], None]] = None
        self.error_callback: Optional[Callable[[Exception], None]] = None
    
    def start_processing(self):
        """Start the audio processing pipeline"""
        self.is_running = True
    
    def stop_processing(self):
        """Stop the audio processing pipeline"""
        self.is_running = False
    
    def process_audio_chunk(self, audio_chunk: np.ndarray, 
                           timestamp_ms: float) -> Dict[str, Any]:
        """Process a single audio chunk through the pipeline
        
        Args:
            audio_chunk: Raw audio samples
            timestamp_ms: Timestamp of the audio chunk
            
        Returns:
            Processing results including action and metadata
        """
        if not self.is_running:
            return {"action": "skip", "timestamp_ms": timestamp_ms}
        
        # Step 1: Resample if needed
        if not self.resampler.is_passthrough(self.sample_rate):
            audio_chunk = self.resampler.resample(audio_chunk, self.sample_rate)
        
        # Step 2: Process through VAD and silence suppressor
        vad_state, speech_ended = self.vad.process_chunk(audio_chunk, timestamp_ms)
        action, _ = self.silence_suppressor.process_chunk(audio_chunk, timestamp_ms)
        
        # Step 3: Determine output action
        if action == "send":
            # Send audio chunk directly
            if self.audio_callback:
                self.audio_callback(audio_chunk)
            return {
                "action": "send",
                "timestamp_ms": timestamp_ms,
                "speech_ended": speech_ended,
                "audio_samples": len(audio_chunk)
            }
        elif action == "silence":
            # Create silence chunk for activity maintenance
            silence_samples = int(self.sample_rate * (self.silence_suppressor.max_silence_duration_ms / 1000))
            silence_chunk = np.zeros(silence_samples, dtype=np.int16)
            
            if self.audio_callback:
                self.audio_callback(silence_chunk)
            return {
                "action": "silence",
                "timestamp_ms": timestamp_ms,
                "speech_ended": speech_ended,
                "audio_samples": silence_samples
            }
        else:
            # Suppress audio - do nothing
            return {
                "action": "suppress",
                "timestamp_ms": timestamp_ms,
                "speech_ended": speech_ended,
                "audio_samples": 0
            }
    
    def set_callbacks(self, 
                      audio_callback: Callable[[np.ndarray], None],
                      error_callback: Optional[Callable[[Exception], None]] = None):
        """Set callbacks for audio processing"""
        self.audio_callback = audio_callback
        self.error_callback = error_callback
    
    def reset(self):
        """Reset the processing pipeline"""
        self.is_running = False
        self.vad = VoiceActivityDetector()
        self.silence_suppressor = SilenceSuppressor(
            self.vad,
            min_speech_duration_ms=100.0,
            max_silence_duration_ms=500.0
        )


class AudioProcessor:
    """Audio processing pipeline for OSMOS"""
    
    def __init__(self, sample_rate: int = 16000, target_sample_rate: int = 16000):
        self.sample_rate = sample_rate
        self.target_sample_rate = target_sample_rate
        self.pipeline = AudioProcessingPipeline(sample_rate, target_sample_rate)
    
    def process_audio_chunk(self, audio_chunk: np.ndarray, timestamp_ms: float) -> Dict[str, Any]:
        """Process audio chunk through the pipeline"""
        return self.pipeline.process_audio_chunk(audio_chunk, timestamp_ms)
    
    def start_processing(self):
        """Start the processing pipeline"""
        self.pipeline.start_processing()
    
    def stop_processing(self):
        """Stop the processing pipeline"""
        self.pipeline.stop_processing()
    
    def reset(self):
        """Reset the processing pipeline"""
        self.pipeline.reset()
