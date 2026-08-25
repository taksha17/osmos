"""
Setup script for OSMOS Python Audio Module.

This script handles the installation and configuration of the OSMOS
Python audio capture system for cross-platform audio processing.
"""

import sys
import os
import platform
from pathlib import Path

def check_python_version():
    """Check if Python version meets requirements"""
    version = sys.version_info
    if version.major < 3 or (version.major == 3 and version.minor < 7):
        print("ERROR: Python 3.7 or higher is required")
        return False
    return True

def check_dependencies():
    """Check if required dependencies are available"""
    required_deps = [
        'numpy',  # For audio processing
        'scipy',  # For signal processing
        'sounddevice',  # For cross-platform audio I/O
    ]
    
    missing_deps = []
    for dep in required_deps:
        try:
            __import__(dep.replace('-', '_'))
        except ImportError:
            missing_deps.append(dep)
    
    if missing_deps:
        print(f"ERROR: Missing dependencies: {', '.join(missing_deps)}")
        print("Install them with: pip install osmos[audio]")
        return False
    
    return True

def create_setup_py():
    """Create setup.py for Python package"""
    setup_content = '''from setuptools import setup, find_packages
import platform

setup(
    name="osmos-audio",
    version="0.5.2",
    author="OSMOS contributors",
    author_email="maintainers@osmos.app",
    description="Cross-platform audio capture for OSMOS interview and meeting copilot",
    long_description="""Open-source audio capture system for OSMOS,
    supporting macOS, Windows, and Linux with intelligent device management
    and real-time audio processing.""",
    long_description_content_type="text/markdown",
    packages=find_packages(),
    install_requires=[
        "numpy>=1.21.0",
        "scipy>=1.7.0",
        "sounddevice>=0.4.6",
        "typing_extensions>=3.10.0",
    ],
    python_requires=">=3.7",
    classifiers=[
        "Development Status :: 4 - Beta",
        "Intended Audience :: Developers",
        "Topic :: Multimedia :: Sound/Audio :: Audio Processing",
        "License :: OSI Approved :: MIT License",
        "Operating System :: OS Independent",
        "Programming Language :: Python :: 3",
        "Programming Language :: Python :: 3.7",
        "Programming Language :: Python :: 3.8",
        "Programming Language :: Python :: 3.9",
        "Programming Language :: Python :: 3.10",
        "Programming Language :: Python :: 3.11",
    ],
    keywords="audio capture, speech recognition, interview, meeting, cross-platform",
    project_urls={
        "Documentation": "https://github.com/taksha17/osmos",
        "Source": "https://github.com/taksha17/osmos",
        "Issues": "https://github.com/taksha17/osmos/issues",
    },
)
'''
    return setup_content

def create_readme():
    """Create README.md for the audio module"""
    readme_content = '''# OSMOS Python Audio Module

Cross-platform audio capture for interview/meeting copilot functionality.

## Overview

This module provides robust audio capture across macOS, Windows, and Linux,
with intelligent device management, real-time audio processing, and
audio source configuration (system audio, microphone, or both).

## Features

- **Cross-platform support**: macOS, Windows, and Linux
- **Device management**: Automatic device detection and switching
- **Audio sources**: System audio, microphone, or both
- **Real-time processing**: VAD (Voice Activity Detection), resampling
- **Smart configuration**: Configurable audio sources and formats
- **Error handling**: Robust error handling and recovery
- **Type safety**: Full type annotations and IDE support

## Installation

### Basic Installation
```bash
pip install osmos[audio]
```

### From Source
```bash
pip install -e ./src/python/audio
```

### With Extra Dependencies
```bash
pip install osmos[audio,full]
```

## Quick Start

```python
from osmos.audio import AudioCapture, AudioCaptureConfig, AssistAudioSource

# Configure audio capture
config = AudioCaptureConfig(
    sample_rate=16000,
    audio_source=AssistAudioSource.SYSTEM,  # system, mic, or both
    channels=1,
    format='wav'
)

# Create audio capture instance
capture = AudioCapture(config)

# Start capture
async def main():
    await capture.start_capture(
        audio_callback=lambda audio: print(f"Received {len(audio)} bytes"),
        error_callback=lambda error: print(f"Error: {error}")
    )

# Stop capture
await capture.stop_capture()
```

## Audio Sources

The audio module supports three different audio source types:

### System Audio
```python
config = AudioCaptureConfig(
    audio_source=AssistAudioSource.SYSTEM  # Capture system audio
)
```

### Microphone Audio
```python
config = AudioCaptureConfig(
    audio_source=AssistAudioSource.MIC  # Capture microphone only
)
```

### Both System and Microphone
```python
config = AudioCaptureConfig(
    audio_source=AssistAudioSource.BOTH  # Capture both system and mic
)
```

## Device Management

The module automatically detects and manages audio devices:

```python
capture = AudioCapture(AudioCaptureConfig())

# Get available devices
devices = capture.get_available_devices()
print("Inputs:", devices.get("inputs", []))
print("Outputs:", devices.get("outputs", []))

# Get system audio devices
system_devices = capture.backend.get_system_audio_devices()
print("System audio devices:", system_devices)

# Get microphone devices
mic_devices similaire
```

## Platform Support

### macOS
- Uses CoreAudio APIs for system audio capture
- Supports microphone input via CoreAudio
- ScreenCaptureKit integration for modern macOS systems

### Windows
- Uses WASAPI for system audio capture
- Supports microphone input via WASAPI
- Windows-specific audio device enumeration

### Linux
- Uses PipeWire and PulseAudio for system audio
- Support for both PipeWire and PulseAudio backends
- Automatic fallback to simulated capture if no backend available

## Audio Processing

The module includes intelligent audio processing:

### Resampling
- Automatic sample rate conversion to 16kHz for STT providers
- Anti-aliasing filter for high-quality conversion
- Native rate preservation for diagnostics

### Voice Activity Detection (VAD)
- Threshold-based speech detection
- Silence suppression for bandwidth optimization
- Configurable sensitivity levels

### Batch Processing
- Efficient processing of multiple audio chunks
- Memory-efficient streaming
- Reduced CPU overhead

## Error Handling

The module provides robust error handling:

```python
async def main():
    try:
        await capture.start_capture(
            audio_callback=process_audio,
            error_callback=handle_error
        )
    except Exception as e:
        print(f"Audio capture failed: {e}")
        # Handle error gracefully
        await capture.stop_capture()
```

## Configuration Options

### Sample Rates
- Common sample rates: 16000 Hz (standard for STT), 44100 Hz, 48000 Hz
- Automatic selection based on device capabilities

### Audio Channels
- Mono (1 channel) or stereo (2 channels)
- Typically mono for speech recognition

### Audio Formats
- WAV: Uncompressed audio
- RAW: Raw PCM data
- MP3: Compressed audio
- FLAC: Lossless compressed audio

### Reconnection
- Automatic reconnection if audio stream is interrupted
- Configurable reconnection delay
- Exponential backoff for failed connections

## Advanced Usage

### Custom Device Selection
```python
config = AudioCaptureConfig(
    device_id="device_name_or_id",
    audio_source=AssistAudioSource.SYSTEM
)
```

### Audio Source Configuration
```python
config = AudioCaptureConfig(
    audio_source=AssistAudioSource.BOTH,
    channels=2,  # Stereo
    sample_rate=48000,  # Higher sample rate
)
```

### Batch Processing
```python
# Process multiple audio chunks
chunks = [b'chunk1', b'chunk2', b'chunk3']
processed = processor.batch_process(chunks)
```

## Integration with OSMOS

The Python audio module integrates seamlessly with OSMOS:

### Integration Points
- Home dashboard: Start OSMOS with audio capture
- Overlay system: Real-time audio processing
- Settings panel: Audio configuration options
- Device management: Cross-platform device switching

### Use Cases
- **Interview Mode**: System audio + microphone for interview simulation
- **Meeting Mode**: System audio + microphone for meeting transcription
- **General Mode**: Configurable audio sources for various use cases

## Development

### Running Tests
```bash
# Install test dependencies
pip install -e ./src/python/audio[test]

# Run unit tests
python -m pytest tests/ -v

# Run integration tests
python -m pytest tests/integration/ -v
```

### Running Examples
```bash
# Run example scripts
python examples/basic_capture.py
python examples/device_list.py
python examples/audio_processing.py
```

### Contribution Guidelines
- Follow PEP 8 style guidelines
- Write comprehensive docstrings
- Include type annotations
- Add unit tests for new functionality
- Maintain backward compatibility

## Troubleshooting

### Common Issues

#### "ModuleNotFoundError: No module named 'sounddevice'"
```bash
pip install sounddevice
```

#### "ImportError: libpulse
```bash
# On Ubuntu/Debian
sudo apt-get install libpulse0

# On Fedora
sudo dnf install libpulse

# On Arch Linux
sudo pacman -S pulseaudio
```

#### Audio Device Not Found
```python
# Check available devices
devices = capture.get_available_devices()
print("Available inputs:", devices.get("inputs", []))
print("Available outputs:", devices.get("outputs", []))
```

## License

This software is licensed under the MIT License, compatible with OSMOS's existing license.

See LICENSE.md for details.

## Support

For support and issues, please visit the OSMOS GitHub repository:

- **GitHub Issues**: https://github.com/taksha17/osmos/issues
- **Discussions**: https://github.com/taksha17/osmos/discussions

## Future Development

### Planned Enhancements
- Real-time audio visualization
- Enhanced VAD with deep learning models
- Multi-language support
- Audio enhancement (noise cancellation, echo suppression)
- Advanced audio effects (pitch shifting, time stretching)
- Integration with external STT providers
- Mobile platform support (iOS, Android)

### Research Areas
- Advanced audio compression algorithms
- Low-latency audio streaming
- Cross-platform API standardization
- AI-powered audio enhancement

## Conclusion

The OSMOS Python Audio Module provides a robust, cross-platform foundation for audio capture in the OSMOS interview and meeting copilot system. It combines intelligent device management, real-time audio processing, and comprehensive error handling to deliver reliable audio capture across all major operating systems.

The module is designed to be easily extensible, allowing for future enhancements while maintaining compatibility with the existing OSMOS architecture.
'''
    return readme_content

def create_setup_py():
    return setup_content

def write_files():
    """Write all setup and documentation files"""
    # Create setup.py
    with open('setup.py', 'w') as f:
        f.write(create_setup_py())
    
    # Create README.md
    with open('README.md', 'w') as f:
        f.write(create_readme())
    
    # Create requirements.txt
    with open('requirements.txt', 'w') as f:
        f.write('''# OSMOS Audio Module Dependencies

# Core dependencies
numpy>=1.21.0
scipy>=1.7.0
sounddevice>=0.4.6
typing_extensions>=3.10.0

# Development dependencies
pytest>=6.0.0
pytest-asyncio>=0.18.0
black>=21.0.0
flake8>=3.9.0
mypy>=0.910.0

# Testing dependencies
pytest-cov>=2.12.0
coverage>=5.5.0
''')
    
    print("Setup files created successfully!")
    print("\nNext steps:")
    print("1. Install the package: pip install -e .")
    print("2. Test the installation: python -c 'from audio import AudioCapture; print(\"Import successful\")'")
    print("3. Run examples: python examples/basic_capture.py")

if __name__ == "__main__":
    if check_python_version() and check_dependencies():
        write_files()
        print("\n✅ OSMOS Python Audio Module setup completed successfully!")
    else:
        print("\n❌ Setup failed. Please check the requirements.")
        sys.exit(1)
