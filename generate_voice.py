import os
import sys
import argparse
import subprocess
import base64
import requests
import json
from pathlib import Path
from dotenv import load_dotenv
import io

# Force UTF-8 encoding for standard output/error to prevent encoding crashes on Windows
if sys.platform.startswith('win'):
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding='utf-8')

# Load workspace .env if present
load_dotenv()

STATE_FILE = Path("temp/api_key_state.json")

def load_key_state(num_keys: int):
    """
    Loads current index and generation count from local state file.
    """
    STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
    if STATE_FILE.exists():
        try:
            with open(STATE_FILE, "r", encoding="utf-8") as f:
                state = json.load(f)
                current_idx = state.get("current_index", 0)
                gen_count = state.get("generation_count", 0)
                # Guard rails for index out of bounds
                if current_idx >= num_keys:
                    current_idx = 0
                return current_idx, gen_count
        except Exception:
            pass
    return 0, 0

def save_key_state(current_idx: int, gen_count: int):
    """
    Saves current index and generation count to local state file.
    """
    try:
        STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
        with open(STATE_FILE, "w", encoding="utf-8") as f:
            json.dump({
                "current_index": current_idx,
                "generation_count": gen_count
            }, f, indent=2)
    except Exception as e:
        print(f"Warning: Failed to save API key state: {e}", file=sys.stderr)

def get_api_keys():
    """
    Retrieves all unique Gemini API keys from environment variables.
    Checks:
    - GEMINI_API_KEY and GOOGLE_API_KEY (supports comma-separated list of keys)
    - GEMINI_API_KEY_1, GEMINI_API_KEY_2, ...
    """
    keys = []
    # 1. Main vars
    for env_var in ["GEMINI_API_KEY", "GOOGLE_API_KEY"]:
        val = os.environ.get(env_var)
        if val:
            for k in val.split(","):
                k_clean = k.strip()
                if k_clean and k_clean not in keys:
                    keys.append(k_clean)
                    
    # 2. Numbered vars
    for i in range(1, 21):
        val = os.environ.get(f"GEMINI_API_KEY_{i}")
        if val:
            for k in val.split(","):
                k_clean = k.strip()
                if k_clean and k_clean not in keys:
                    keys.append(k_clean)
                    
    return keys

def generate_voice_gemini(text: str, output_wav_path: str, voice_name: str, keys: list):
    """
    Generates speech using the Gemini 3.1 Flash TTS model.
    Pre-emptively rotates key every 5 generations.
    Rolls over to next key on any request error.
    Converts the raw PCM output to 44.1kHz stereo WAV via ffmpeg.
    """
    num_keys = len(keys)
    if num_keys == 0:
        raise ValueError("No Gemini API keys found. Please check your .env file.")

    current_idx, gen_count = load_key_state(num_keys)

    # Pre-emptive rotation
    if gen_count >= 5:
        print(f"Rotating API key pre-emptively after {gen_count} generations.")
        current_idx = (current_idx + 1) % num_keys
        gen_count = 0

    attempts = 0
    last_error = None
    while attempts < num_keys:
        api_key = keys[current_idx]
        print(f"Trying API Key {current_idx + 1}/{num_keys} (gen count: {gen_count + 1}/5, ending in ...{api_key[-5:] if len(api_key) > 5 else ''})")
        url = f"https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-tts-preview:generateContent?key={api_key}"
        headers = {"Content-Type": "application/json"}
        
        payload = {
            "contents": [{
                "parts": [{"text": text}]
            }],
            "generationConfig": {
                "responseModalities": ["AUDIO"],
                "speechConfig": {
                    "voiceConfig": {
                        "prebuiltVoiceConfig": {
                            "voiceName": voice_name
                        }
                    }
                }
            }
        }
        
        try:
            response = requests.post(url, headers=headers, json=payload, timeout=180)
            if response.status_code == 429:
                try:
                    res_json = response.json()
                    details = res_json.get("error", {}).get("details", [])
                    retry_sec = None
                    for detail in details:
                        if detail.get("@type") == "type.googleapis.com/google.rpc.RetryInfo":
                            delay_str = detail.get("retryDelay", "")
                            if isinstance(delay_str, str) and delay_str.endswith("s"):
                                retry_sec = float(delay_str[:-1])
                            else:
                                retry_sec = float(delay_str)
                            break
                    if retry_sec is None:
                        retry_sec = 15.0
                    sleep_time = retry_sec + 2.0
                    print(f"Rate limit hit. Sleeping for {sleep_time:.2f} seconds, then rotating key...")
                    import time
                    time.sleep(sleep_time)
                    current_idx = (current_idx + 1) % num_keys
                    gen_count = 0
                    attempts += 1
                    continue
                except Exception as parse_err:
                    print(f"Failed to parse 429 response: {parse_err}. Sleeping 15s, then rotating key...")
                    import time
                    time.sleep(15.0)
                    current_idx = (current_idx + 1) % num_keys
                    gen_count = 0
                    attempts += 1
                    continue

            if response.status_code != 200:
                raise Exception(f"API Error (status {response.status_code}): {response.text}")
                
            res_data = response.json()
            parts = res_data["candidates"][0]["content"]["parts"]
            audio_b64 = None
            for part in parts:
                if "inlineData" in part:
                    audio_b64 = part["inlineData"]["data"]
                    break
            if not audio_b64:
                raise ValueError("No audio inlineData found in response.")
                
            audio_bytes = base64.b64decode(audio_b64)
            temp_pcm = output_wav_path + ".pcm"
            
            with open(temp_pcm, "wb") as f:
                f.write(audio_bytes)
                
            try:
                # Convert PCM (16-bit, little-endian, 24kHz, mono) to WAV (16-bit, 44.1kHz, stereo)
                cmd_ffmpeg = [
                    "ffmpeg", "-y",
                    "-f", "s16le",
                    "-ar", "24000",
                    "-ac", "1",
                    "-i", temp_pcm,
                    "-ar", "44100",
                    "-ac", "2",
                    output_wav_path
                ]
                subprocess.run(cmd_ffmpeg, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=True)
            finally:
                if os.path.exists(temp_pcm):
                    os.remove(temp_pcm)
                    
            # Update state on success
            gen_count += 1
            save_key_state(current_idx, gen_count)
            print("Successfully generated speech and saved WAV file.")
            return # Success!
            
        except Exception as e:
            print(f"Key {current_idx + 1} failed: {e}")
            last_error = e
            # Rotate key on error
            current_idx = (current_idx + 1) % num_keys
            gen_count = 0
            attempts += 1
            continue
            
    # If we loop through all keys and none work:
    save_key_state(current_idx, 0) # reset count
    raise Exception(f"All {len(keys)} API keys failed. Last error: {last_error}")

def restore_yo(text: str) -> str:
    """
    Programmatic replacements to restore the letter 'ё' in common words
    so that the TTS model pronounces them correctly.
    """
    replacements = {
        "преодоленное": "преодолённое",
        "Преодоленное": "Преодолённое",
        "преодоленного": "преодолённого",
        "преодоленным": "преодолённым",
        "преодоленные": "преодолённые",
        "преодоленных": "преодолённых",
        "преодоленными": "преодолёнными",
        "преодолели": "преодолели", # no ё
        "все решает": "всё решает",
        "Все решает": "Всё решает",
        "решенная": "решённая",
        "Решенная": "Решённая",
        "решенное": "решённое",
        "Решенное": "Решённое",
        "решенный": "решённый",
        "Решенный": "Решённый",
        "решенные": "решённые",
        "Решенные": "Решённые",
        "решенных": "решённых",
        "решенную": "решённую",
        "решенной": "решённой",
        "напряженная": "напряжённая",
        "Напряженная": "Напряжённая",
        "напряженное": "напряжённое",
        "напряженный": "напряжённый",
        "напряженные": "напряжённые",
        "напряженных": "напряжённых",
        "напряженным": "напряжённым",
        "напряженную": "напряжённую",
        "напряженной": "напряжённой",
        "ученого": "учёного",
        "Ученого": "Учёного",
        "ученый": "учёный",
        "Ученый": "Учёный",
        "ученые": "учёные",
        "ученых": "учёных",
        "определенных": "определённых",
        "определенной": "определённой",
        "определенное": "определённое",
        "определенный": "определённый",
        "определенные": "определённые",
        
        "проселочной": "просёлочной",
        "Проселочной": "Просёлочной",
        "проселочные": "просёлочные",
        "Проселочные": "Просёлочной",
        "проселочную": "просёлочную",
        "Проселочную": "Просёлочную",
        "проселочный": "просёлочный",
        "Проселочный": "Просёлочный",
        "проселочного": "просёлочного",
        "проселочному": "просёлочному",
        "проселочным": "просёлочным",
        "проселочном": "просёлочном",
        "проселочных": "просёлочных",
        "проселочными": "просёлочными",

        "черных": "чёрных",
        "Черных": "Чёрных",
        "черный": "чёрный",
        "Черный": "Чёрный",
        "черного": "чёрного",
        "черному": "чёрному",
        "черным": "чёрным",
        "черном": "чёрном",
        "черная": "чёрная",
        "черную": "чёрную",
        "черной": "чёрной",
        "черное": "чёрное",
        "черные": "чёрные",
        "черными": "чёрными",

        "новорожденный": "новорождённый",
        "Новорожденный": "Новорождённый",
        "новорожденного": "новорождённого",
        "новорожденному": "новорождённому",
        "новорожденным": "новорождённым",
        "новорожденном": "новорождённом",
        "новорожденные": "новорождённые",
        "новорожденных": "новорождённых",
        "новорожденными": "новорождёнными",

        "ребенок": "ребёнок",
        "Ребенок": "Ребёнок",
        "ребенка": "ребёнка",
        "Ребенка": "Ребёнка",
        "ребенку": "ребёнку",
        "ребенком": "ребёнком",
        "ребенке": "ребёнке",

        "дергает": "дёргает",
        "Дергает": "Дёргает",

        "перекрестных": "перекрёстных",
        "Перекрестных": "Перекрёстных",
        "перекрестный": "перекрёстный",
        "Перекрестный": "Перекрёстный",
        "перекрестного": "перекрёстного",
        "перекрестному": "перекрёстному",
        "перекрестным": "перекрёстным",
        "перекрестном": "перекрёстном",
        "перекрестная": "перекрёстная",
        "перекрественную": "перекрёстную",
        "перекрестной": "перекрёстной",
        "перекрестное": "перекрёстное",
        "перекрестные": "перекрёстные",
        "перекрестными": "перекрёстными",

        "врожденный": "врождённый",
        "Врожденный": "Врождённый",
        "врожденного": "врождённого",
        "врожденному": "врождённому",
        "врожденным": "врождённым",
        "врожденном": "врождённом",
        "врожденная": "врождённая",
        "врожденную": "врождённую",
        "врожденной": "врождённой",
        "врожденное": "врождённое",
        "врожденные": "врождённые",
        "врожденных": "врождённых",
        "врожденными": "врождёнными",

        "надежный": "надёжный",
        "Надежный": "Надёжный",
        "надежного": "надёжного",
        "надежному": "надёжному",
        "надежным": "надёжным",
        "надежном": "надёжном",
        "надежная": "надёжная",
        "надежную": "надёжную",
        "надежной": "надёжной",
        "надежное": "надёжное",
        "надежные": "надёжные",
        "надежных": "надёжных",
        "надежными": "надёжными",

        "тренажеры": "тренажёры",
        "Тренажеры": "Тренажёры",
        "тренажер": "тренажёр",
        "Тренажер": "Тренажёр",
        "тренажера": "тренажёра",
        "тренажеру": "тренажёру",
        "тренажером": "тренажёром",
        "тренажере": "тренажёре",
        "тренажеров": "тренажёров",
        "тренажерами": "тренажёрами",
        "тренажерах": "тренажёрах",

        "учеба": "учёба",
        "Учеба": "Учёба",
        "учебы": "учёбы",
        "Учебы": "Учёбы",
        "учебе": "учёбе",
        "учебу": "учёбу",
        "учебой": "учёбой",

        "емкость": "ёмкость",
        "Емкость": "Ёмкость",
        "емкости": "ёмкости",
        "Емкости": "Ёмкости",
        "емкостью": "ёмкостью",
        "емкостей": "ёмкостей",
        "емкостям": "ёмкостям",
        "емкостями": "ёмкостями",
        "емкостях": "ёмкостях",

        "дается": "даётся",
        "Дается": "Даётся",
        "приведет": "приведёт",
        "Приведет": "Приведёт",
        "еще": "ещё",
        "Еще": "Ещё",
        "свое": "своё",
        "Свое": "Своё",
        "твое": "твоё",
        "Твое": "Твоё",
        "мое": "моё",
        "Мое": "Моё",
        "своем": "своём",
        "твоем": "твоём",
        "моем": "моём",
        "ведет": "ведёт",
        "Ведет": "Ведёт",
        "идет": "идёт",
        "Идет": "Идёт",
        "желтый": "жёлтый",
        "Желтый": "Жёлтый",
        "самолет": "самолёт",
        "Самолет": "Самолёт",
        "берет": "берёт",
        "Берет": "Берёт",
    }
    for k, v in replacements.items():
        text = text.replace(k, v)
    return text

def main():
    parser = argparse.ArgumentParser(description="HtmlVR Gemini TTS Speech Generation Utility (with API Key Rotation)")
    parser.add_argument("--text", required=True, help="Text transcript to synthesize")
    parser.add_argument("--output", required=True, help="Destination WAV file path")
    parser.add_argument("--voice", default="Sadaltager", help="Prebuilt voice name for Gemini (default: Sadaltager)")
    parser.add_argument("--profile", default="The Podcast News Anchor", help="Profile description/persona preset")
    parser.add_argument("--scene", default="A professional recording studio. High quality condenser microphone, soundproofed room.", help="Scene environment preset")
    parser.add_argument("--preset", choices=["normal", "energetic", "podcast", "custom"], default="normal", help="Choose a style preset")
    parser.add_argument("--style-notes", default=None, help="Director style guidelines (overrides preset)")
    parser.add_argument("--pace-notes", default=None, help="Director pacing guidelines (overrides preset)")
    
    args = parser.parse_args()
    
    # Check for keys
    keys = get_api_keys()
    if not keys:
        print("Error: No Gemini API keys found. Set GEMINI_API_KEY or GEMINI_API_KEY_1, _2... in environment/ .env.", file=sys.stderr)
        sys.exit(1)

    # Clean text to restore Ё letter
    text_clean = restore_yo(args.text)

    # Determine style and pace based on preset and overrides
    style_notes = args.style_notes
    pace_notes = args.pace_notes

    if args.preset == "normal":
        if style_notes is None:
            style_notes = "Презентация на ТЭД. Ты очень хорошо подготовлена, говоришь уверенно, эмоционально, с ясным и светлым тембром."
        if pace_notes is None:
            pace_notes = "Умеренный темп речи. Говори в естественном разговорном ритме. Паузы между предложениями стандартные, комфортные для восприятия."
    elif args.preset == "energetic":
        if style_notes is None:
            style_notes = "Энергичный, вовлекающий стиль презентации. Светлый и высокий тон голоса, ясный тембр, без глухоты."
        if pace_notes is None:
            pace_notes = "Живой, достаточно бодрый и уверенный темп речи. Динамичное повествование, без лишних задержек."
    elif args.preset == "podcast":
        if style_notes is None:
            style_notes = "Стиль: Профессиональный диктор научно-популярных новостей (news anchor) с теплой, доброжелательной подачей. Тон уверенный, авторитетный, но близкий и располагающий, с мягкой улыбкой в голосе. Артикуляция: Мягкая, естественная, без нарочитого выговаривания слогов. Полностью исключи любые заминки, вздохи и запинки импровизации."
        if pace_notes is None:
            pace_notes = "Уверенный, умеренно-беглый и чёткий темп речи (без спешки, но и без медленных театральных пауз между словами). Слова плавно перетекают одно в другое, формируя единую цельную линию повествования."
    else: # custom
        if style_notes is None:
            style_notes = "Professional presentation style. Confident, authoritative, yet warm and conversational."
        if pace_notes is None:
            pace_notes = "Normal, conversational pace."
        
    # Build advanced prompt structure
    full_prompt = (
        f"# AUDIO PROFILE: {args.voice}\n"
        f"## \"{args.profile}\"\n\n"
        f"## THE SCENE: {args.scene}\n\n"
        f"### DIRECTOR'S NOTES\n"
        f"Style:\n* {style_notes}\n\n"
        f"Pace:\n* {pace_notes}\n\n"
        f"#### TRANSCRIPT\n"
        f"{text_clean}"
    )

    try:
        generate_voice_gemini(full_prompt, args.output, args.voice, keys)
    except Exception as e:
        print(f"Failed to generate voiceover: {e}", file=sys.stderr)
        sys.exit(1)

if __name__ == "__main__":
    main()
