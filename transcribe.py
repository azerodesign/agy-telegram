import sys
import os
import subprocess
import json

def transcribe(audio_path, groq_api_key=None):
    # 1. Convert to 16kHz mono WAV using ffmpeg
    wav_path = f"/tmp/stt_{os.getpid()}_{os.path.basename(audio_path)}.wav"
    try:
        cmd = [
            "ffmpeg", "-y", "-i", audio_path,
            "-ar", "16000", "-ac", "1",
            wav_path
        ]
        res = subprocess.run(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        if res.returncode != 0:
            return {"success": False, "error": "Konversi audio ffmpeg gagal"}

        # 2. If Groq API key is provided, prefer Groq Whisper
        if groq_api_key:
            try:
                import urllib.request
                boundary = "----WebKitFormBoundary7MA4YWxkTrZu0gW"
                # read wav
                with open(wav_path, "rb") as f:
                    file_data = f.read()

                body = (
                    f"--{boundary}\r\n"
                    f'Content-Disposition: form-data; name="file"; filename="audio.wav"\r\n'
                    f"Content-Type: audio/wav\r\n\r\n"
                ).encode("utf-8") + file_data + (
                    f"\r\n--{boundary}\r\n"
                    f'Content-Disposition: form-data; name="model"\r\n\r\n'
                    f"whisper-large-v3\r\n"
                    f"--{boundary}--\r\n"
                ).encode("utf-8")

                req = urllib.request.Request(
                    "https://api.groq.com/openai/v1/audio/transcriptions",
                    data=body,
                    headers={
                        "Authorization": f"Bearer {groq_api_key}",
                        "Content-Type": f"multipart/form-data; boundary={boundary}"
                    }
                )
                with urllib.request.urlopen(req, timeout=30) as resp:
                    data = json.loads(resp.read().decode())
                    return {"success": True, "text": data.get("text", "").strip()}
            except Exception as e:
                # Fallback to local / google STT
                pass

        # 3. Google Web Speech API via SpeechRecognition
        import speech_recognition as sr
        r = sr.Recognizer()
        with sr.AudioFile(wav_path) as source:
            audio_data = r.record(source)

        # Coba bahasa Indonesia dulu, lalu fallback ke English
        try:
            text = r.recognize_google(audio_data, language="id-ID")
            return {"success": True, "text": text}
        except sr.UnknownValueError:
            try:
                text = r.recognize_google(audio_data, language="en-US")
                return {"success": True, "text": text}
            except Exception as e:
                return {"success": False, "error": "Suara tidak terdengar jelas atau kosong"}
        except Exception as e:
            return {"success": False, "error": str(e)}

    finally:
        if os.path.exists(wav_path):
            try:
                os.remove(wav_path)
            except Exception:
                pass

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(json.dumps({"success": False, "error": "Path file audio diperlukan"}))
        sys.exit(1)

    audio_file = sys.argv[1]
    groq_key = os.environ.get("GROQ_API_KEY")
    result = transcribe(audio_file, groq_key)
    print(json.dumps(result, ensure_ascii=False))
