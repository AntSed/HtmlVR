# HtmlVR: System Architecture & Agent Workspace Guide

HtmlVR is a lightweight, programmatically controllable HTML5 video sequencer, timeline editor, and headless rendering pipeline. It is designed to bridge the gap between interactive browser editing and automated AI-agent-directed media production.

---

## 1. Project Philosophy & Design Core

HtmlVR is built on three main design principles:

1. **AI-Agent Native (Primary Design):** Every aspect of the application is designed to be read, manipulated, and triggered by autonomous agents. State representation (`temp/project_state.json`) is optimized for small context foot-prints, comments on the timeline serve as commands (e.g. `/narrate`, `/slide`, `/scene`), and the server exposes dedicated `/api/agent/state` endpoints for automated analysis.
2. **Reaper DAW Architecture:**
   - **Universal Tracks:** Tracks do not have a fixed media type. Any track can hold HTML templates, MP4/WebM videos, PNG/JPG images, MP3/WAV narration voiceovers, or background music.
   - **Dynamic Stack:** Tracks are dynamically generated and can be rearranged, shifted, or deleted without breaking asset positioning.
   - **Interactive Volume/Compression Bands:** Audio clips utilize a visual "compressor band" where dragging shifts the compression threshold and ratio parameters.
3. **Offline Rendering Engine:** Uses a Puppeteer-driven Chromium headless instance to seek frame-by-frame, capture JPG sequences, synthesize offline Web Audio buffers into standard WAV files, and mux everything into high-definition MP4 videos via FFmpeg.

---

## 2. Directory Structure

```
c:\HtmlVR\
├── agent_director.py         # AI Agent timeline automation & CLI script
├── monitor_trigger.py        # Background loop monitoring browser triggers
├── test_render.py            # Simple script to test render engine API
├── server.js                 # Express server with Puppeteer/FFmpeg render pipeline
├── package.json              # Node dependencies (express, puppeteer)
├── temp/                     # Workspace state, frames, temporary audio/video caches
├── renders/                  # Output directory for compiled MP4 videos
├── public/                   # Static server resources
│   ├── editor.html           # Timeline Editor GUI layout
│   ├── editor.css            # Dark premium GUI stylesheet
│   ├── editor.js             # Timeline engine, dragging, audio analysis, API clients
│   ├── render-host.html      # Puppeteer sandboxed render viewport
│   ├── assets/               # Workspace assets (images, logos, audio tracks)
│   └── compositions/         # HTML visual slide & particle compositions
```

> [!IMPORTANT]
> **Project Build Scripts Placement Rule:**
> Project-specific build automation scripts (e.g., `build_genius_stickman_partX.py`) MUST NOT reside in the root directory. They must be stored inside their respective project directories:
> `public/projects/<project_name>/` or `public/projects/<project_name>/build/`.
> The root directory is reserved for core system scripts and shared utilities.

---

## 3. Server REST API (server.js)

The Express server listens on port `3333` and serves the following endpoints:

| Endpoint | Method | Description |
| :--- | :--- | :--- |
| `/api/compositions` | `GET` | Returns list of available visual and media assets in `public/compositions`. |
| `/api/upload` | `POST` | Uploads base64 encoded media files to the server's compositions directory. |
| `/api/delete` | `DELETE` | Deletes a composition/media file from disk (with path-traversal protection). |
| `/api/project/state` | `POST` | Saves current timeline project tracks and markers to `temp/project_state.json`. |
| `/api/project/state` | `GET` | Loads saved timeline project tracks and markers from `temp/project_state.json`. |
| `/api/agent/state` | `GET` | Returns a consolidated state for the AI Agent: project state, files, and automatic WAV analysis (RMS level, duration, and 20-point loudness graph). |
| `/api/agent/trigger` | `POST` | Writes `temp/agent_trigger.txt` to trigger autonomous execution. |
| `/api/render` | `POST` | Compiles project sequence to MP4 using parallel Puppeteer pages and FFmpeg. |

### SSE Render Stream Details

The `/api/render` endpoint streams Server-Sent Events (SSE) to update the caller on progress:

- `status`: Sends a text message update (e.g., "Launching Chromium...") and progress estimation.
- `progress`: Sends progress percent (`0` to `90`), current frame index, and total frames.
- `success`: Returns the compiled video filename and access path (e.g. `/renders/render_xxxx.mp4`).
- `error`: Returns error text on compilation failure.

---

## 4. Automation & CLI Options (agent_director.py)

The Python orchestrator script provides several commands to automate timeline assembly:

- **Marker Processor Loop (Default, no args):**
  Fetches the editor state. Scans timeline markers for text commands:
  - `/narrate <Text>`: Generates voiceover TTS audio, saves it as a WAV asset, and places it on the audio track (track index 2) at the marker's time.
  - `/slide <Title> \| <Desc>`: Generates a premium visual slide using the pro-pool model or fallback template, and places it on track 0.
  - `/scene <Desc>`: Generates a procedural Canvas animation (3D particles/flowfields) and places it on track 1.
- `--build <script.json>`: Sequences an entire video automatically from a JSON script containing text narrations and corresponding visual instructions (slides or scenes).
- `--normalize`: Auto-levels WAV audio volumes to a target RMS value.
- `--generate-music`: Generates melancholic procedural ambient backing music to a WAV file.

---

## 5. Agent Listener Loop (Auto-Wakeup Loop)

1. Run `python monitor_trigger.py` in the background. It polls for `temp/agent_trigger.txt`.
2. When the user clicks **"Send to Agent"** in the browser editor, the server writes this trigger file.
3. `monitor_trigger.py` detects the file, deletes it, and exits.
4. The IDE agent wakes up, runs `python agent_director.py` to compile changes/narrate text/arrange slides, and then resumes the background monitor.

---

## 6. Local Pro Pool Usage Guidelines (Orchestrator/Worker)

To maintain code structure, avoid regressions, and preserve successful visual designs:

1. **Primary Generation:** Use the local Pro pool server (`gemini-3.5-pro` model) for initial, from-scratch creation of complex visual compositions.
2. **Refinements and Edits:** Do **NOT** use the Pro pool for editing or tweaking existing files. Make edits manually using precise replacements (e.g. standard file edit tools) to avoid wiping out working mechanics, breaking camera layouts, or introducing unrequested UI overlays.
3. **Preserve User Timeline Edits:** When programmatically rebuilding a project timeline or writing the `project_state.json`, never reset or discard custom offsets, transforms (Scale, Offsets, Opacity), segment marker notes, or custom track assignments that the user configured manually in the timeline editor UI. Always read the existing `project_state.json` first, and merge the generated media clips into it, preserving any user-defined positioning and clip overrides.

---

## 7. Clip Properties Panel (Asset Settings Panel)

The clip properties panel (located in the left sidebar under `#clip-properties-panel`) is automatically displayed when a visual clip (HTML composition, video, or image) is selected on the timeline. It allows real-time manipulation of the active clip's properties:

### Core Adjustments:
- **Scale (Uniform, X, Y):** Adjusts the visual size multipliers. If Uniform Scale is dragged, X and Y scales are automatically kept in sync.
- **Offset X / Y (px):** Positions the element relative to the viewport center.
- **Rotation (Deg):** Visual rotation angle (clamped between -180 and 180 degrees).
- **Opacity:** Transparency value ranging from 0.0 (hidden) to 1.0 (opaque).
- **Mirror (Horizontal):** Checks whether the visual element should be flipped horizontally (achieved by multiplying the computed horizontal scale by `-1` in the rendering context).

### Clip Transitions:
- **Transition In / Out:** Selects transition styles (`fade`, `slide-left`, `slide-right`, `slide-up`, `slide-down`, `zoom`, `rotate`) and durations for automatic interpolation.

### Subproject Internal Defaults:
- Custom style, default transition duration, and override rules when rendering a subproject clip sequence.

### Quick Actions:
- **Clone Clip:** Creates an identical duplicate of the selected clip at the same timestamp. It searches neighboring tracks (first below, then above) for empty space; if both are occupied, it inserts a new track below the current one to place the cloned clip.
- **Reset Transform:** Instantly restores original dimensions and orientation (Scale = 1.0, Offsets = 0, Rotation = 0, Opacity = 1.0, Mirror = false).

---

## 8. Subproject Clips (Embedded Timelines)

HtmlVR allows embedding entire projects as subproject clips inside tracks of other projects, similar to Reaper Subprojects or DaVinci Timelines.

### Architecture & Mechanics:
- **Reference Format:** Subproject clips are represented on the timeline with a source prefix `project:<project_name>` (e.g., `project:intro_sequence`).
- **Render Pipeline & Nested Playback:**
  - On initialization in `render-host.html`, the engine fetches the nested project's state via `/api/project/state?project=<project_name>`.
  - The source is replaced on the fly with a sandboxed `render-host.html` URL containing the subproject state encoded in Base64.
  - Seeking is propagated recursively: the parent timeline seek triggers seeking in subproject iframes (`win.seekTo(localTime, isJump)`).
- **Offline Audio Rendering:**
  - `renderAudioOffline()` recursively traverses nested HTML frames.
  - Subproject offline audio contexts are mixed into the parent offline audio mix at the proper start offsets and durations.

### Editor Interactions:
- **Insertion:** Users can insert another project as a clip at the current playhead position using the project list modal.
- **Direct Editing:** Subproject clips feature an `[Edit ↗]` link that navigates the editor directly to that project's timeline (`?project=<project_name>`).
- **Auto Duration & Ripple Sync:**
  - On load or reload, `editor.js` compares the clip duration against the actual duration of the subproject.
  - If a duration mismatch is detected, the clip is resized, and a **Ripple Edit** is triggered automatically: all subsequent clips on the timeline are shifted by the difference to prevent overlaps or gaps.

