#!/usr/bin/env python3
"""
Lightweight Speech-to-Text transcriber using speech_recognition.
Supports Indonesian (id-ID) primary and English (en-US) fallback.
"""

import sys
import os
import speech_recognition as sr

def transcribe_audio(audio_path: str):
    if not os.path.isfile(audio_path):
        print(f"Error: File {audio_path} not found", file=sys.stderr)
        sys.exit(1)

    r = sr.Recognizer()
    try:
        with sr.AudioFile(audio_path) as source:
            audio = r.record(source)
    except Exception as e:
        print(f"Error reading audio file: {e}", file=sys.stderr)
        sys.exit(1)

    text = None
    # 1. Try Indonesian
    try:
        text = r.recognize_google(audio, language="id-ID")
    except Exception:
        pass

    # 2. Try English fallback
    if not text:
        try:
            text = r.recognize_google(audio, language="en-US")
        except Exception:
            pass

    if text and text.strip():
        print(text.strip())
        sys.exit(0)
    else:
        print("Error: Could not transcribe audio (no speech detected)", file=sys.stderr)
        sys.exit(1)

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: transcribe.py <audio.wav>", file=sys.stderr)
        sys.exit(1)
    transcribe_audio(sys.argv[1])
