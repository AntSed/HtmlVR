(function () {
  'use strict';

  window.AnimateTool = {
    open: function (activeBlock, currentProject, project, onComplete) {
      if (!activeBlock) {
        console.error('AnimateTool: activeBlock is required.');
        return;
      }

      // 1. Extract Clip Metadata
      const clipId = activeBlock.dataset.id || '';
      const clipName = activeBlock.innerText || activeBlock.textContent || 'Untitled Clip';
      const clipDuration = parseFloat(activeBlock.dataset.duration) || 10;

      let enteredFullscreenAutomatically = false;
      const canvasContainer = document.getElementById('canvas-container');
      const targetParent = canvasContainer || document.body;

      // Parse existing animate_tool metadata if present
      let animations = [];
      let pivotX = 50;
      let pivotY = 50;

      if (activeBlock.dataset.animateTool) {
        try {
          let parsed = JSON.parse(activeBlock.dataset.animateTool);
          if (parsed) {
            if (!Array.isArray(parsed)) {
              parsed = [parsed];
            }
            animations = parsed;
          }
        } catch (e) {
          console.warn('AnimateTool: error parsing existing metadata', e);
        }
      }

      if (animations.length === 0) {
        animations.push({
          type: 'translate',
          start_time: 0,
          end_time: clipDuration,
          direction_angle: 90,
          amplitude: 30,
          periodicity: 3,
          pivot: [50, 50],
          easing: 'linear'
        });
      }

      let activeIndex = 0;
      const anim = animations[activeIndex];
      let animType = anim.type;
      let animStart = anim.start_time;
      let animEnd = anim.end_time;
      let animDir = anim.direction_angle;
      let animAmp = anim.amplitude;
      let animFreq = anim.periodicity;
      if (anim.pivot && Array.isArray(anim.pivot)) {
        pivotX = parseFloat(anim.pivot[0]);
        pivotY = parseFloat(anim.pivot[1]);
      }

      // 2. State Management
      let isDrawing = false;
      let isPivotMode = false;
      let brushMode = 'draw'; // 'draw' or 'erase'
      let brushSize = 20;
      let dilation = 4;
      const undoStack = [];
      const redoStack = [];

      // Canvas Zoom & Pan State
      let canvasScale = 1.0;
      let canvasPanX = 0;
      let canvasPanY = 0;
      let isSpacePressed = false;
      let isPanning = false;
      let panStartX = 0;
      let panStartY = 0;
      let isPanelCollapsed = false;

      // 3. Ensure Overlay UI and Styles Exist
      let overlay = document.getElementById('animate-tool-overlay');
      if (!overlay) {
        overlay = document.createElement('div');
        overlay.id = 'animate-tool-overlay';
        
        // Inject production-ready styles dynamically
        const style = document.createElement('style');
        style.id = 'animate-tool-styles';
        style.textContent = `
          #animate-tool-overlay {
            position: fixed;
            top: 0;
            left: 0;
            width: 100vw;
            height: 100vh;
            background: rgba(15, 23, 42, 0.4);
            z-index: 99999;
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
            color: #e0e0e0;
            display: flex;
            user-select: none;
          }
          #animate-tool-canvas-container {
            position: absolute;
            box-shadow: 0 10px 30px rgba(0,0,0,0.5);
            background: transparent;
            overflow: hidden;
            z-index: 10;
          }
          #animate-tool-canvas {
            width: 100%;
            height: 100%;
            display: block;
            cursor: crosshair;
            opacity: 0.55;
          }
          #animate-tool-pivot-marker {
            position: absolute;
            width: 24px;
            height: 24px;
            transform: translate(-50%, -50%);
            pointer-events: none;
            border: 2px solid #00ffff;
            border-radius: 50%;
            display: flex;
            align-items: center;
            justify-content: center;
            box-shadow: 0 0 8px #00ffff;
            transition: left 0.1s ease, top 0.1s ease;
          }
          #animate-tool-pivot-marker .pivot-center {
            width: 6px;
            height: 6px;
            background: #00ffff;
            border-radius: 50%;
          }
          #animate-tool-panel {
            position: absolute;
            right: 0;
            top: 0;
            width: 320px;
            height: 100%;
            background: #1e1e24;
            border-left: 1px solid #333;
            display: flex;
            flex-direction: column;
            box-shadow: -5px 0 25px rgba(0,0,0,0.3);
            z-index: 10010;
            transition: transform 0.3s cubic-bezier(0.4, 0, 0.2, 1);
          }
          .at-panel-header {
            padding: 16px;
            background: #25252d;
            border-bottom: 1px solid #333;
            font-size: 16px;
            font-weight: 600;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
          }
          .at-panel-content {
            padding: 16px;
            flex: 1;
            overflow-y: auto;
          }
          .at-section {
            margin-bottom: 20px;
          }
          .at-section-title {
            font-size: 12px;
            text-transform: uppercase;
            color: #888;
            letter-spacing: 1px;
            margin-bottom: 10px;
            font-weight: 700;
          }
          .at-row {
            display: flex;
            gap: 8px;
            margin-bottom: 8px;
          }
          .at-btn {
            flex: 1;
            background: #2a2a35;
            border: 1px solid #444;
            color: #fff;
            padding: 8px 12px;
            border-radius: 4px;
            cursor: pointer;
            font-size: 13px;
            font-weight: 500;
            transition: all 0.2s;
            text-align: center;
          }
          .at-btn:hover {
            background: #353545;
            border-color: #555;
          }
          .at-btn.active {
            background: #007acc;
            border-color: #0098ff;
          }
          .at-btn.btn-danger {
            background: #5a2525;
            border-color: #723030;
          }
          .at-btn.btn-danger:hover {
            background: #723030;
          }
          .at-control-group {
            margin-bottom: 12px;
          }
          .at-control-group label {
            display: flex;
            justify-content: space-between;
            font-size: 13px;
            margin-bottom: 4px;
            color: #ccc;
          }
          .at-control-group input[type="range"] {
            width: 100%;
            accent-color: #007acc;
            margin: 4px 0;
          }
          .at-control-group input[type="checkbox"] {
            margin-right: 8px;
            accent-color: #007acc;
          }
          .at-checkbox-label {
            display: flex;
            align-items: center;
            cursor: pointer;
            font-size: 13px;
          }
          .at-panel-footer {
            padding: 16px;
            background: #25252d;
            border-top: 1px solid #333;
            display: flex;
            gap: 12px;
          }
          #animate-tool-spinner {
            position: absolute;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            background: rgba(0, 0, 0, 0.7);
            display: none;
            align-items: center;
            justify-content: center;
            z-index: 100000;
          }
          #animate-tool-spinner.visible {
            display: flex;
          }
          .spinner-ring {
            width: 50px;
            height: 50px;
            border: 4px solid rgba(255,255,255,0.1);
            border-top-color: #007acc;
            border-radius: 50%;
            animation: at-spin 1s linear infinite;
          }
          @keyframes at-spin {
            to { transform: rotate(360deg); }
          }
        `;
        document.head.appendChild(style);
        targetParent.appendChild(overlay);

        // Request fullscreen automatically on launch for a distraction-free experience
        if (canvasContainer && !document.fullscreenElement) {
          canvasContainer.requestFullscreen().then(() => {
            enteredFullscreenAutomatically = true;
          }).catch(err => {
            console.warn("AnimateTool: failed to enter fullscreen automatically:", err);
          });
        }
      }

      overlay.innerHTML = `
        <div id="animate-tool-canvas-container">
          <img id="animate-tool-background-image" style="position: absolute; top: 0; left: 0; width: 100%; height: 100%; object-fit: contain; pointer-events: none; z-index: 9995;">
          <canvas id="animate-tool-canvas" width="1920" height="1080" style="position: absolute; top: 0; left: 0; width: 100%; height: 100%; z-index: 9997; cursor: crosshair;"></canvas>
          <div id="animate-tool-brush-preview" style="position: absolute; border: 1.5px solid #ffffff; border-radius: 50%; pointer-events: none; transform: translate(-50%, -50%); display: none; box-shadow: 0 0 4px rgba(0,0,0,0.5); z-index: 9998;"></div>
          <svg id="animate-tool-vector-svg" style="position: absolute; top: 0; left: 0; width: 100%; height: 100%; pointer-events: none; z-index: 9999;">
            <line id="animate-tool-vector-line" x1="0" y1="0" x2="0" y2="0" stroke="#ff00ff" stroke-width="3" stroke-dasharray="4 4" style="filter: drop-shadow(0 0 3px #ff00ff);" />
          </svg>
          <div id="animate-tool-pivot-marker" style="z-index: 10000;">
            <div class="pivot-center"></div>
          </div>
          <div id="animate-tool-vector-handle" style="position: absolute; width: 22px; height: 22px; border-radius: 50%; background: #ff00ff; border: 2px solid #ffffff; box-shadow: 0 0 10px #ff00ff; transform: translate(-50%, -50%); cursor: move; z-index: 10001;"></div>
        </div>
        <div id="animate-tool-panel">
          <div id="at-btn-panel-toggle" style="position: absolute; left: -32px; top: 50%; transform: translateY(-50%); width: 32px; height: 64px; background: #1e1e24; border: 1px solid #333; border-right: none; border-radius: 8px 0 0 8px; display: flex; align-items: center; justify-content: center; cursor: pointer; box-shadow: -5px 0 15px rgba(0,0,0,0.2); z-index: 10015; color: #fff; font-size: 14px; transition: transform 0.3s ease;">◀</div>
          <div class="at-panel-header" id="at-panel-title"></div>
          <div class="at-panel-content">
            <div class="at-section">
              <div class="at-section-title">Brush Controls</div>
              <div class="at-row">
                <button class="at-btn active" id="at-btn-draw">Draw Mode</button>
                <button class="at-btn" id="at-btn-erase">Eraser Mode</button>
              </div>
              <div class="at-control-group">
                <label><span>Brush Size</span><span id="at-val-brush">20px</span></label>
                <input type="range" id="at-slider-brush" min="1" max="100" value="20">
              </div>
              <div class="at-control-group">
                <label><span>Inpaint Dilation</span><span id="at-val-dilation">4px</span></label>
                <input type="range" id="at-slider-dilation" min="0" max="20" step="1" value="4">
              </div>
              <button class="at-btn btn-danger" id="at-btn-clear" style="width:100%;">Clear Mask</button>
            </div>
            
            <div class="at-section">
              <div class="at-section-title">Pivot Placement</div>
              <button class="at-btn" id="at-btn-pivot-toggle" style="width:100%;">Place Pivot</button>
            </div>
            
            <div class="at-section">
              <div class="at-section-title">Parameters</div>
              <div class="at-control-group">
                <label><span>Animation Type</span></label>
                <select id="at-select-type" class="at-btn" style="width: 100%; text-align: left; background: #2a2a35; border: 1px solid #444; color: #fff; padding: 8px 12px; border-radius: 4px; font-size: 13px;">
                  <option value="translate">Translate (Linear)</option>
                  <option value="translate_sinusoidal">Translate (Sinusoidal)</option>
                  <option value="rotate">Rotate</option>
                  <option value="scale">Scale</option>
                  <option value="shake">Shake / Viggle</option>
                </select>
              </div>
              <div class="at-control-group">
                <label><span>Easing</span></label>
                <select id="at-select-easing" class="at-btn" style="width: 100%; text-align: left; background: #2a2a35; border: 1px solid #444; color: #fff; padding: 8px 12px; border-radius: 4px; font-size: 13px;">
                  <option value="linear">Linear</option>
                  <option value="sine_in">Sine In</option>
                  <option value="sine_out">Sine Out</option>
                  <option value="sine_in_out">Sine In-Out</option>
                  <option value="elastic">Elastic</option>
                  <option value="bounce">Bounce</option>
                </select>
              </div>
              <div class="at-control-group">
                <label><span>Start Time</span><span id="at-val-start">${animStart.toFixed(2)}s</span></label>
                <input type="range" id="at-slider-start" min="0" max="${clipDuration}" step="0.05" value="${animStart}">
              </div>
              <div class="at-control-group">
                <label><span>End Time</span><span id="at-val-end">${animEnd.toFixed(2)}s</span></label>
                <input type="range" id="at-slider-end" min="0" max="${clipDuration}" step="0.05" value="${animEnd}">
              </div>
              <div class="at-control-group" id="at-group-dir">
                <label><span>Direction</span><span id="at-val-dir">${animDir}°</span></label>
                <input type="range" id="at-slider-dir" min="0" max="360" step="5" value="${animDir}">
              </div>
              <div class="at-control-group">
                <label><span id="at-label-amp">Amplitude</span><span id="at-val-amp">${animAmp}</span></label>
                <input type="range" id="at-slider-amp" min="0" max="200" step="1" value="${animAmp}">
              </div>
              <div class="at-control-group">
                <label><span>Periodicity / Freq</span><span id="at-val-freq">${animFreq}</span></label>
                <input type="range" id="at-slider-freq" min="1" max="999" step="1" value="${animFreq}">
              </div>
              <div class="at-control-group">
                <label class="at-checkbox-label">
                  <input type="checkbox" id="at-check-inpaint" checked>
                  Inpaint Background
                </label>
              </div>
            </div>
          </div>
          <div class="at-panel-footer">
            <button class="at-btn btn-danger" id="at-btn-cancel">Cancel</button>
            <button class="at-btn active" id="at-btn-save">Save</button>
          </div>
        </div>
        <div id="animate-tool-spinner">
          <div class="spinner-ring"></div>
        </div>
      `;

      // 5. Get Element References
      const container = document.getElementById('animate-tool-canvas-container');
      const canvas = document.getElementById('animate-tool-canvas');
      const brushPreview = document.getElementById('animate-tool-brush-preview');
      const pivotMarker = document.getElementById('animate-tool-pivot-marker');
      const vectorSvg = document.getElementById('animate-tool-vector-svg');
      const vectorLine = document.getElementById('animate-tool-vector-line');
      const vectorHandle = document.getElementById('animate-tool-vector-handle');
      const spinner = document.getElementById('animate-tool-spinner');
      const ctx = canvas.getContext('2d');
  
      const btnDraw = document.getElementById('at-btn-draw');
      const btnErase = document.getElementById('at-btn-erase');
      const btnClear = document.getElementById('at-btn-clear');
      const btnPivotToggle = document.getElementById('at-btn-pivot-toggle');
      const btnCancel = document.getElementById('at-btn-cancel');
      const btnSave = document.getElementById('at-btn-save');
      const selectType = document.getElementById('at-select-type');
      const selectEasing = document.getElementById('at-select-easing');
      const btnAddAnimation = document.getElementById('at-btn-add-animation');
  
      const sliderBrush = document.getElementById('at-slider-brush');
      const sliderDilation = document.getElementById('at-slider-dilation');
      const sliderStart = document.getElementById('at-slider-start');
      const sliderEnd = document.getElementById('at-slider-end');
      const sliderDir = document.getElementById('at-slider-dir');
      const sliderAmp = document.getElementById('at-slider-amp');
      const sliderFreq = document.getElementById('at-slider-freq');
      const checkInpaint = document.getElementById('at-check-inpaint');
  
      const valBrush = document.getElementById('at-val-brush');
      const valDilation = document.getElementById('at-val-dilation');
      const valStart = document.getElementById('at-val-start');
      const valEnd = document.getElementById('at-val-end');
      const valDir = document.getElementById('at-val-dir');
      const valAmp = document.getElementById('at-val-amp');
      const valFreq = document.getElementById('at-val-freq');

      // Set initial canvas styles and load original image
      canvas.style.opacity = '0.6';
      
      const img = new Image();
      img.src = activeBlock.dataset.src.startsWith('/') ? activeBlock.dataset.src : '/' + activeBlock.dataset.src;
      let originalImageLoaded = false;
      img.onload = () => {
        originalImageLoaded = true;
        const bgImg = document.getElementById('animate-tool-background-image');
        if (bgImg) bgImg.src = img.src;
        // Push initial clean frame onto undo stack
        undoStack.push(ctx.getImageData(0, 0, 1920, 1080));
      };
      function getEasing(easing, t) {
        t = Math.max(0, Math.min(1, t));
        if (easing === 'sine_in') {
          return 1 - Math.cos((t * Math.PI) / 2);
        } else if (easing === 'sine_out') {
          return Math.sin((t * Math.PI) / 2);
        } else if (easing === 'sine_in_out') {
          return -(Math.cos(Math.PI * t) - 1) / 2;
        } else if (easing === 'elastic') {
          const c4 = (2 * Math.PI) / 3;
          return t === 0 ? 0 : t === 1 ? 1 : -Math.pow(2, 10 * t - 10) * Math.sin((t * 10 - 10.75) * c4);
        } else if (easing === 'bounce') {
          const n1 = 7.5625;
          const d1 = 2.75;
          if (t < 1 / d1) {
            return n1 * t * t;
          } else if (t < 2 / d1) {
            return n1 * (t -= 1.5 / d1) * t + 0.75;
          } else if (t < 2.5 / d1) {
            return n1 * (t -= 2.25 / d1) * t + 0.9375;
          } else {
            return n1 * (t -= 2.625 / d1) * t + 0.984375;
          }
        }
        return t; // linear
      }

      const groupDir = document.getElementById('at-group-dir');
      const labelAmp = document.getElementById('at-label-amp');

      function updateTypeControls() {
        const anim = animations[activeIndex];
        if (!anim) return;

        if (anim.type === 'rotate') {
          if (groupDir) groupDir.style.display = 'none';
          if (labelAmp) labelAmp.innerText = 'Amplitude (Deg)';
          sliderAmp.min = 0;
          sliderAmp.max = 1800;
          sliderAmp.step = 1;
          sliderAmp.value = anim.amplitude;
          if (valAmp) valAmp.innerText = `${anim.amplitude}°`;
          if (vectorSvg) vectorSvg.style.display = 'none';
          if (vectorHandle) vectorHandle.style.display = 'none';
        } else if (anim.type === 'scale') {
          if (groupDir) groupDir.style.display = 'none';
          if (labelAmp) labelAmp.innerText = 'Amplitude (Scale Change)';
          sliderAmp.min = 0;
          sliderAmp.max = 25;
          sliderAmp.step = 0.1;
          sliderAmp.value = anim.amplitude;
          if (valAmp) valAmp.innerText = anim.amplitude;
          if (vectorSvg) vectorSvg.style.display = 'none';
          if (vectorHandle) vectorHandle.style.display = 'none';
        } else if (anim.type === 'shake') {
          if (groupDir) groupDir.style.display = 'none';
          if (labelAmp) labelAmp.innerText = 'Amplitude (px)';
          sliderAmp.min = 0;
          sliderAmp.max = 1000;
          sliderAmp.step = 1;
          sliderAmp.value = anim.amplitude;
          if (valAmp) valAmp.innerText = anim.amplitude;
          if (vectorSvg) vectorSvg.style.display = 'none';
          if (vectorHandle) vectorHandle.style.display = 'none';
        } else {
          if (groupDir) groupDir.style.display = 'block';
          if (labelAmp) labelAmp.innerText = 'Amplitude (px)';
          sliderAmp.min = 0;
          sliderAmp.max = 5000;
          sliderAmp.step = 1;
          sliderAmp.value = anim.amplitude;
          if (valAmp) valAmp.innerText = anim.amplitude;
          if (vectorSvg) vectorSvg.style.display = 'block';
          if (vectorHandle) vectorHandle.style.display = 'block';
        }
      }

      function renderAnimationsList() {
        const listContainer = document.getElementById('at-animations-list');
        if (!listContainer) return;

        listContainer.innerHTML = '';
        animations.forEach((anim, idx) => {
          const item = document.createElement('div');
          item.className = `at-animation-item ${idx === activeIndex ? 'active' : ''}`;
          item.style.cssText = `
            display: flex;
            align-items: center;
            justify-content: space-between;
            background: ${idx === activeIndex ? 'linear-gradient(135deg, rgba(168, 85, 247, 0.2), rgba(0, 240, 255, 0.15))' : 'rgba(30, 41, 59, 0.4)'};
            border: 1px solid ${idx === activeIndex ? '#a855f7' : 'rgba(255, 255, 255, 0.08)'};
            border-radius: 8px;
            padding: 8px 12px;
            cursor: pointer;
            transition: all 0.2s;
            margin-bottom: 4px;
          `;

          let typeStr = anim.type;
          if (anim.type === 'translate') typeStr = 'Translate (Linear)';
          else if (anim.type === 'translate_sinusoidal') typeStr = 'Translate (Sinusoidal)';
          else if (anim.type === 'rotate') typeStr = 'Rotate';
          else if (anim.type === 'scale') typeStr = 'Scale';
          else if (anim.type === 'shake') typeStr = 'Shake/Viggle';

          const textSpan = document.createElement('span');
          textSpan.innerText = `${idx + 1}. ${typeStr} (${anim.easing || 'linear'})`;
          textSpan.style.cssText = `
            font-size: 13px;
            font-weight: 500;
            color: ${idx === activeIndex ? '#fff' : '#ccc'};
          `;

          const deleteSpan = document.createElement('span');
          deleteSpan.innerHTML = '🗑️';
          deleteSpan.style.cssText = `
            color: #ef4444;
            cursor: pointer;
            font-size: 14px;
            padding: 2px 6px;
            border-radius: 4px;
            transition: background 0.2s;
          `;
          deleteSpan.title = 'Delete Animation';

          deleteSpan.onmouseover = () => { deleteSpan.style.background = 'rgba(239, 68, 68, 0.15)'; };
          deleteSpan.onmouseout = () => { deleteSpan.style.background = 'transparent'; };

          item.onclick = (e) => {
            if (e.target === deleteSpan) {
              e.stopPropagation();
              if (animations.length <= 1) {
                alert('You must have at least one animation on the clip.');
                return;
              }
              if (confirm('Delete this animation?')) {
                animations.splice(idx, 1);
                if (activeIndex >= animations.length) {
                  activeIndex = animations.length - 1;
                }
                loadActiveAnimation();
              }
              return;
            }
            activeIndex = idx;
            loadActiveAnimation();
          };

          item.appendChild(textSpan);
          item.appendChild(deleteSpan);
          listContainer.appendChild(item);
        });
      }

      function loadActiveAnimation() {
        const anim = animations[activeIndex];
        if (!anim) return;

        sliderStart.value = anim.start_time;
        valStart.innerText = `${parseFloat(anim.start_time).toFixed(2)}s`;

        sliderEnd.value = anim.end_time;
        valEnd.innerText = `${parseFloat(anim.end_time).toFixed(2)}s`;

        sliderDir.value = anim.direction_angle;
        valDir.innerText = `${anim.direction_angle}°`;

        sliderAmp.value = anim.amplitude;
        valAmp.innerText = anim.amplitude;

        sliderFreq.value = anim.periodicity;
        valFreq.innerText = anim.periodicity;

        selectType.value = anim.type;
        selectEasing.value = anim.easing || 'linear';

        if (anim.pivot && Array.isArray(anim.pivot)) {
          pivotX = parseFloat(anim.pivot[0]);
          pivotY = parseFloat(anim.pivot[1]);
        } else {
          pivotX = 50;
          pivotY = 50;
        }

        updatePivotDisplay();
        updateTypeControls();
        updateVectorDisplay();
        renderAnimationsList();
      }

      // Add Animation Listener
      if (btnAddAnimation) {
        btnAddAnimation.addEventListener('click', () => {
          animations.push({
            type: 'translate',
            start_time: 0,
            end_time: clipDuration,
            direction_angle: 90,
            amplitude: 30,
            periodicity: 3,
            pivot: [50, 50],
            easing: 'linear'
          });
          activeIndex = animations.length - 1;
          loadActiveAnimation();
        });
      }

      // Type & Easing Select Listeners
      if (selectType) {
        selectType.addEventListener('change', function () {
          const anim = animations[activeIndex];
          if (anim) {
            anim.type = this.value;
            // Set default amp for scale if type changed to scale to avoid massive initial size
            if (anim.type === 'scale') {
              anim.amplitude = 1.0;
            } else if (anim.type === 'rotate') {
              anim.amplitude = 45;
            } else {
              anim.amplitude = 30;
            }
            loadActiveAnimation();
          }
        });
      }

      if (selectEasing) {
        selectEasing.addEventListener('change', function () {
          const anim = animations[activeIndex];
          if (anim) {
            anim.easing = this.value;
            renderAnimationsList();
          }
        });
      }

      // Initialize
      setTimeout(() => {
        loadActiveAnimation();
      }, 50);

      // Set Header Title
      document.getElementById('at-panel-title').innerText = `Masking: ${clipName}`;

      // Visual handle updating function
      function updateVectorDisplay() {
        const W = container.offsetWidth || 1920;
        const H = container.offsetHeight || 1080;
        if (W === 0 || H === 0) return;
        
        const anim = animations[activeIndex];
        if (!anim) return;

        const pX = anim.pivot ? parseFloat(anim.pivot[0]) : 50;
        const pY = anim.pivot ? parseFloat(anim.pivot[1]) : 50;
        
        const pivotPxX = (pX / 100) * W;
        const pivotPxY = (pY / 100) * H;
        const screenAmp = anim.amplitude * (W / 1920);
        const rad = (anim.direction_angle * Math.PI) / 180;
        
        const handlePxX = pivotPxX + screenAmp * Math.cos(rad);
        const handlePxY = pivotPxY + screenAmp * Math.sin(rad);
        
        if (vectorLine) {
          vectorLine.setAttribute('x1', pivotPxX);
          vectorLine.setAttribute('y1', pivotPxY);
          vectorLine.setAttribute('x2', handlePxX);
          vectorLine.setAttribute('y2', handlePxY);
        }
        
        if (vectorHandle) {
          vectorHandle.style.left = `${handlePxX}px`;
          vectorHandle.style.top = `${handlePxY}px`;
        }
      }

      // Dragging vector handle mechanics
      let isDraggingVector = false;

      function handleVectorDragStart(e) {
        e.preventDefault();
        e.stopPropagation();
        isDraggingVector = true;
        document.addEventListener('mousemove', handleVectorDragMove);
        document.addEventListener('mouseup', handleVectorDragEnd);
        document.addEventListener('touchmove', handleVectorTouchMove, { passive: false });
        document.addEventListener('touchend', handleVectorDragEnd);
      }

      function handleVectorDragMove(e) {
        if (!isDraggingVector) return;
        const rect = canvas.getBoundingClientRect();
        const W = rect.width;
        const H = rect.height;
        if (W === 0 || H === 0) return;

        const clientX = e.touches && e.touches.length > 0 ? e.touches[0].clientX : e.clientX;
        const clientY = e.touches && e.touches.length > 0 ? e.touches[0].clientY : e.clientY;

        const anim = animations[activeIndex];
        if (!anim) return;

        const pX = anim.pivot ? parseFloat(anim.pivot[0]) : 50;
        const pY = anim.pivot ? parseFloat(anim.pivot[1]) : 50;

        const pivotPxX = (pX / 100) * W;
        const pivotPxY = (pY / 100) * H;
        const mousePxX = clientX - rect.left;
        const mousePxY = clientY - rect.top;

        const dx = mousePxX - pivotPxX;
        const dy = mousePxY - pivotPxY;

        let rad = Math.atan2(dy, dx);
        let degrees = rad * (180 / Math.PI);
        if (degrees < 0) {
          degrees += 360;
        }

        const screenAmp = Math.sqrt(dx * dx + dy * dy);
        let amp = screenAmp * (1920 / W);

        anim.direction_angle = Math.max(0, Math.min(360, Math.round(degrees)));
        anim.amplitude = Math.max(0, Math.min(5000, Math.round(amp)));

        sliderDir.value = anim.direction_angle;
        valDir.innerText = `${anim.direction_angle}°`;

        sliderAmp.value = anim.amplitude;
        valAmp.innerText = anim.amplitude;

        updateVectorDisplay();
      }

      function handleVectorTouchMove(e) {
        if (e.cancelable) e.preventDefault();
        handleVectorDragMove(e);
      }

      function handleVectorDragEnd() {
        if (isDraggingVector) {
          isDraggingVector = false;
          document.removeEventListener('mousemove', handleVectorDragMove);
          document.removeEventListener('mouseup', handleVectorDragEnd);
          document.removeEventListener('touchmove', handleVectorTouchMove);
          document.removeEventListener('touchend', handleVectorDragEnd);
        }
      }

      vectorHandle.addEventListener('mousedown', handleVectorDragStart);
      vectorHandle.addEventListener('touchstart', handleVectorDragStart, { passive: false });

      // 6. Centered 16:9 Positioning Helper to prevent canvas coordinate drift
      function repositionContainer() {
        const previewIframe = document.getElementById('preview-iframe');
        if (previewIframe) {
          const rect = previewIframe.getBoundingClientRect();
          
          let width = rect.width;
          let height = rect.height;
          const iframeRatio = width / height;
          const targetRatio = 16 / 9;
          
          let left = rect.left;
          let top = rect.top;
          
          if (iframeRatio > targetRatio) {
            // Wider iframe -> Pillarbox
            width = height * targetRatio;
            left = rect.left + (rect.width - width) / 2;
          } else if (iframeRatio < targetRatio) {
            // Taller iframe -> Letterbox
            height = width / targetRatio;
            top = rect.top + (rect.height - height) / 2;
          }
          
          // Calculate parent relative position to avoid viewport-relative shift when absolute-positioned
          const parentRect = targetParent.getBoundingClientRect();
          const relativeLeft = left - parentRect.left;
          const relativeTop = top - parentRect.top;
          
          container.style.position = 'absolute';
          container.style.left = `${relativeLeft}px`;
          container.style.top = `${relativeTop}px`;
          container.style.width = `${width}px`;
          container.style.height = `${height}px`;
          
          updateContainerTransform();

          // Re-update vector coordinates on reposition/resize
          setTimeout(updateVectorDisplay, 50);
        }
      }

      function debouncedReposition() {
        repositionContainer();
        setTimeout(repositionContainer, 100);
        setTimeout(repositionContainer, 300);
      }

      // Initial positioning call
      debouncedReposition();

      // Bind dynamic window/fullscreen state tracking
      window.addEventListener('resize', debouncedReposition);
      document.addEventListener('fullscreenchange', debouncedReposition);

      // Mouse Wheel zoom bindings
      overlay.addEventListener('wheel', function (e) {
        e.preventDefault();
        
        const zoomFactor = 1.1;
        let newScale = canvasScale;
        if (e.deltaY < 0) {
          newScale = Math.min(8.0, canvasScale * zoomFactor);
        } else {
          newScale = Math.max(0.3, canvasScale / zoomFactor);
        }

        if (newScale !== canvasScale) {
          const rect = container.getBoundingClientRect();
          const mouseX = e.clientX - rect.left;
          const mouseY = e.clientY - rect.top;

          canvasPanX -= mouseX * (newScale / canvasScale - 1);
          canvasPanY -= mouseY * (newScale / canvasScale - 1);
          canvasScale = newScale;

          updateContainerTransform();
        }
      }, { passive: false });

      // Keyboard Spacebar drag pan listeners
      function handleSpaceKeyDown(e) {
        if (e.code === 'Space') {
          const active = document.activeElement;
          if (active && (
            active.tagName === 'TEXTAREA' || 
            active.tagName === 'SELECT' ||
            (active.tagName === 'INPUT' && (active.type === 'text' || active.type === 'number' || active.type === 'password' || active.type === 'email'))
          )) return;
          
          isSpacePressed = true;
          overlay.style.cursor = 'grab';
          canvas.style.cursor = 'grab';
          e.preventDefault(); // Prevent default page scroll
        }
      }

      function handleSpaceKeyUp(e) {
        if (e.code === 'Space') {
          isSpacePressed = false;
          overlay.style.cursor = 'default';
          canvas.style.cursor = 'crosshair';
          e.preventDefault();
        }
      }

      window.addEventListener('keydown', handleSpaceKeyDown);
      window.addEventListener('keyup', handleSpaceKeyUp);

      // Collapsible panel toggler
      const btnPanelToggle = document.getElementById('at-btn-panel-toggle');
      const panelElement = document.getElementById('animate-tool-panel');
      
      if (btnPanelToggle && panelElement) {
        btnPanelToggle.addEventListener('click', function (e) {
          e.stopPropagation();
          isPanelCollapsed = !isPanelCollapsed;
          if (isPanelCollapsed) {
            panelElement.style.transform = 'translateX(320px)';
            btnPanelToggle.innerText = '▶';
            btnPanelToggle.style.transform = 'translateY(-50%)';
          } else {
            panelElement.style.transform = 'none';
            btnPanelToggle.innerText = '◀';
            btnPanelToggle.style.transform = 'translateY(-50%)';
          }
        });
      }

      // Initialize Pivot Marker View
      function updatePivotDisplay() {
        pivotMarker.style.left = `${pivotX}%`;
        pivotMarker.style.top = `${pivotY}%`;
      }
      updatePivotDisplay();
      updateVectorDisplay();

      // 7. Event Helpers for Coordinate Scaling
      function getCanvasCoords(e) {
        const rect = canvas.getBoundingClientRect();
        const clientX = e.touches && e.touches.length > 0 ? e.touches[0].clientX : e.clientX;
        const clientY = e.touches && e.touches.length > 0 ? e.touches[0].clientY : e.clientY;
        return {
          x: (clientX - rect.left) * (1920 / rect.width),
          y: (clientY - rect.top) * (1080 / rect.height),
          rawX: clientX - rect.left,
          rawY: clientY - rect.top,
          width: rect.width,
          height: rect.height
        };
      }

      // 8. Drawing & Interactivity Logic
      function setupCanvasBrush() {
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.lineWidth = brushSize;
        if (brushMode === 'draw') {
          ctx.globalCompositeOperation = 'source-over';
          ctx.strokeStyle = '#ff3333'; // Vibrant semi-transparent red Quick Mask
        } else {
          ctx.globalCompositeOperation = 'destination-out';
        }
      }

      function saveUndoState() {
        undoStack.push(ctx.getImageData(0, 0, 1920, 1080));
        if (undoStack.length > 50) {
          undoStack.shift();
        }
        redoStack.length = 0; // Clear redo
      }

      function undo() {
        if (undoStack.length > 1) {
          const current = undoStack.pop();
          redoStack.push(current);
          const prev = undoStack[undoStack.length - 1];
          ctx.clearRect(0, 0, 1920, 1080);
          ctx.putImageData(prev, 0, 0);
          showToast("Undo");
        } else {
          showToast("Nothing to undo");
        }
      }

      function redo() {
        if (redoStack.length > 0) {
          const next = redoStack.pop();
          undoStack.push(next);
          ctx.clearRect(0, 0, 1920, 1080);
          ctx.putImageData(next, 0, 0);
          showToast("Redo");
        } else {
          showToast("Nothing to redo");
        }
      }

      function updateBrushPreview(e) {
        if (isPivotMode) {
          brushPreview.style.display = 'none';
          return;
        }
        const rect = canvas.getBoundingClientRect();
        const clientX = e.touches && e.touches.length > 0 ? e.touches[0].clientX : e.clientX;
        const clientY = e.touches && e.touches.length > 0 ? e.touches[0].clientY : e.clientY;
        
        // Divide by canvasScale to map from screen pixels to logical container coordinate space
        const x = (clientX - rect.left) / canvasScale;
        const y = (clientY - rect.top) / canvasScale;
        
        const logicalW = container.offsetWidth || 1920;
        const displaySize = brushSize * (logicalW / 1920);
        brushPreview.style.width = `${displaySize}px`;
        brushPreview.style.height = `${displaySize}px`;
        brushPreview.style.left = `${x}px`;
        brushPreview.style.top = `${y}px`;
        brushPreview.style.display = 'block';
      }

      function updateContainerTransform() {
        container.style.transform = `translate(${canvasPanX}px, ${canvasPanY}px) scale(${canvasScale})`;
      }

      function handlePointerDown(e) {
        // Panning check (Middle mouse click, Right mouse click, or Space held drag)
        if (isSpacePressed || e.button === 1 || e.button === 2) {
          isPanning = true;
          panStartX = e.clientX - canvasPanX;
          panStartY = e.clientY - canvasPanY;
          if (e.button === 1 || e.button === 2) {
            e.preventDefault();
          }
          overlay.style.cursor = 'grabbing';
          canvas.style.cursor = 'grabbing';
          return;
        }

        if (isPivotMode) {
          const coords = getCanvasCoords(e);
          pivotX = Math.max(0, Math.min(100, (coords.rawX / coords.width) * 100));
          pivotY = Math.max(0, Math.min(100, (coords.rawY / coords.height) * 100));
          const anim = animations[activeIndex];
          if (anim) {
            anim.pivot = [parseFloat(pivotX.toFixed(2)), parseFloat(pivotY.toFixed(2))];
          }
          updatePivotDisplay();
          updateVectorDisplay();
          return;
        }
        
        isDrawing = true;
        const coords = getCanvasCoords(e);
        setupCanvasBrush();
        ctx.beginPath();
        ctx.moveTo(coords.x, coords.y);
        ctx.lineTo(coords.x, coords.y);
        ctx.stroke();
      }

      function handlePointerMove(e) {
        if (isPanning) {
          canvasPanX = e.clientX - panStartX;
          canvasPanY = e.clientY - panStartY;
          updateContainerTransform();
          return;
        }

        if (isDrawing && !isPivotMode) {
          const coords = getCanvasCoords(e);
          ctx.lineTo(coords.x, coords.y);
          ctx.stroke();
        }
        updateBrushPreview(e);
      }

      function handlePointerUp(e) {
        if (isPanning) {
          isPanning = false;
          overlay.style.cursor = isSpacePressed ? 'grab' : 'default';
          canvas.style.cursor = isSpacePressed ? 'grab' : 'crosshair';
          return;
        }

        if (isDrawing) {
          saveUndoState();
        }
        isDrawing = false;
        ctx.closePath();
      }

      // Attach Drawing & Pivot Mouse Events
      canvas.addEventListener('mousedown', handlePointerDown);
      canvas.addEventListener('mousemove', handlePointerMove);
      window.addEventListener('mouseup', handlePointerUp);
      overlay.addEventListener('contextmenu', e => e.preventDefault());

      // Attach Touch Support
      canvas.addEventListener('touchstart', function(e) {
        if(e.cancelable) e.preventDefault();
        handlePointerDown(e);
      }, { passive: false });
      canvas.addEventListener('touchmove', function(e) {
        if(e.cancelable) e.preventDefault();
        handlePointerMove(e);
      }, { passive: false });
      window.addEventListener('touchend', handlePointerUp);

      // 9. UI Dynamic Value Updates
      sliderBrush.addEventListener('input', function () {
        brushSize = parseInt(this.value, 10);
        valBrush.innerText = `${brushSize}px`;
      });
      sliderDilation.addEventListener('input', function () {
        dilation = parseInt(this.value, 10);
        valDilation.innerText = `${dilation}px`;
      });
      sliderStart.addEventListener('input', function () {
        const anim = animations[activeIndex];
        if (anim) {
          anim.start_time = parseFloat(this.value);
          valStart.innerText = `${anim.start_time.toFixed(2)}s`;
        }
      });
      sliderEnd.addEventListener('input', function () {
        const anim = animations[activeIndex];
        if (anim) {
          anim.end_time = parseFloat(this.value);
          valEnd.innerText = `${anim.end_time.toFixed(2)}s`;
        }
      });
      sliderDir.addEventListener('input', function () {
        const anim = animations[activeIndex];
        if (anim) {
          anim.direction_angle = parseFloat(this.value);
          valDir.innerText = `${anim.direction_angle}°`;
          updateVectorDisplay();
        }
      });
      sliderAmp.addEventListener('input', function () {
        const anim = animations[activeIndex];
        if (anim) {
          anim.amplitude = parseFloat(this.value);
          if (anim.type === 'rotate') {
            valAmp.innerText = `${anim.amplitude}°`;
          } else {
            valAmp.innerText = anim.amplitude;
          }
          updateVectorDisplay();
        }
      });
      sliderFreq.addEventListener('input', function () {
        const anim = animations[activeIndex];
        if (anim) {
          anim.periodicity = parseFloat(this.value);
          valFreq.innerText = anim.periodicity;
        }
      });

      // Mode Selection Configuration
      btnDraw.addEventListener('click', function () {
        isPivotMode = false;
        btnPivotToggle.classList.remove('active');
        brushMode = 'draw';
        btnDraw.classList.add('active');
        btnErase.classList.remove('active');
        if (brushPreview) brushPreview.style.display = 'block';
      });

      btnErase.addEventListener('click', function () {
        isPivotMode = false;
        btnPivotToggle.classList.remove('active');
        brushMode = 'erase';
        btnErase.classList.add('active');
        btnDraw.classList.remove('active');
        if (brushPreview) brushPreview.style.display = 'block';
      });

      btnPivotToggle.addEventListener('click', function () {
        isPivotMode = !isPivotMode;
        if (isPivotMode) {
          btnPivotToggle.classList.add('active');
          btnDraw.classList.remove('active');
          btnErase.classList.remove('active');
          if (brushPreview) brushPreview.style.display = 'none';
        } else {
          btnPivotToggle.classList.remove('active');
          if (brushMode === 'draw') btnDraw.classList.add('active');
          else btnErase.classList.add('active');
          if (brushPreview) brushPreview.style.display = 'block';
        }
      });

      btnClear.addEventListener('click', function () {
        if (confirm('Are you sure you want to completely clear the current mask?')) {
          saveUndoState();
          ctx.clearRect(0, 0, canvas.width, canvas.height);
        }
      });

      // 10. Close and Destroy Action
    function destroyOverlay() {
      // Clean up global listeners attached outside overlay scope
      window.removeEventListener('mouseup', handlePointerUp);
      window.removeEventListener('touchend', handlePointerUp);
      window.removeEventListener('resize', debouncedReposition);
      document.removeEventListener('fullscreenchange', debouncedReposition);
      window.removeEventListener('keydown', handleSpaceKeyDown);
      window.removeEventListener('keyup', handleSpaceKeyUp);
      
      // Clean up vector dragging listener just in case
      document.removeEventListener('mousemove', handleVectorDragMove);
      document.removeEventListener('mouseup', handleVectorDragEnd);
      document.removeEventListener('touchmove', handleVectorTouchMove);
      document.removeEventListener('touchend', handleVectorDragEnd);

      if (overlay && overlay.parentNode) {
        overlay.parentNode.removeChild(overlay);
      }

      // Restore screen mode if we auto-entered fullscreen
      if (enteredFullscreenAutomatically && document.fullscreenElement) {
        document.exitFullscreen().catch(err => {
          console.warn("AnimateTool: failed to exit fullscreen automatically:", err);
        });
      }
    }

    btnCancel.addEventListener('click', destroyOverlay);

      // 11. Compilation and Backend Save Logic
      btnSave.addEventListener('click', async function () {
        spinner.classList.add('visible');

        try {
          if (!originalImageLoaded) {
            throw new Error("Original background image is still loading...");
          }
          const rawW = img.naturalWidth;
          const rawH = img.naturalHeight;

          // Get the mask drawn on the 1920x1080 canvas
          const screenData = ctx.getImageData(0, 0, 1920, 1080);
          const screenPixels = screenData.data;

          // Create target canvas of size rawW x rawH
          const rawCanvas = document.createElement('canvas');
          rawCanvas.width = rawW;
          rawCanvas.height = rawH;
          const rawCtx = rawCanvas.getContext('2d');
          const rawData = rawCtx.createImageData(rawW, rawH);
          const rawPixels = rawData.data;

          // Parse clip transforms
          const panX = parseFloat(activeBlock.dataset.panX) || 0;
          const panY = parseFloat(activeBlock.dataset.panY) || 0;
          const scale = parseFloat(activeBlock.dataset.scale) || 1.0;
          const scaleX = parseFloat(activeBlock.dataset.scaleX) || scale;
          const scaleY = parseFloat(activeBlock.dataset.scaleY) || scale;
          const rotation = parseFloat(activeBlock.dataset.rotation) || 0;
          const mirror = activeBlock.dataset.mirror === "true";

          // Parse playhead and duration
          const playheadTime = parseFloat(document.getElementById('playhead-slider').value) || 0;
          const start = parseFloat(activeBlock.dataset.start) || 0;
          const duration = parseFloat(activeBlock.dataset.duration) || 10;
          const localTime = playheadTime - start;

          // Backward map raw pixels to screen coordinate mask samples by direct scaling
          for (let y = 0; y < rawH; y++) {
            const scrY = Math.round((y / rawH) * 1080);
            
            for (let x = 0; x < rawW; x++) {
              const scrX = Math.round((x / rawW) * 1920);

              const rawIdx = (y * rawW + x) * 4;
              
              if (scrX >= 0 && scrX < 1920 && scrY >= 0 && scrY < 1080) {
                const scrIdx = (scrY * 1920 + scrX) * 4;
                const alphaVal = screenPixels[scrIdx + 3];
                if (alphaVal > 10) {
                  rawPixels[rawIdx] = 255;
                  rawPixels[rawIdx + 1] = 255;
                  rawPixels[rawIdx + 2] = 255;
                  rawPixels[rawIdx + 3] = 255;
                } else {
                  rawPixels[rawIdx] = 0;
                  rawPixels[rawIdx + 1] = 0;
                  rawPixels[rawIdx + 2] = 0;
                  rawPixels[rawIdx + 3] = 255;
                }
              } else {
                rawPixels[rawIdx] = 0;
                rawPixels[rawIdx + 1] = 0;
                rawPixels[rawIdx + 2] = 0;
                rawPixels[rawIdx + 3] = 255;
              }
            }
          }

          rawCtx.putImageData(rawData, 0, 0);

          // Isolate Base64 Raw PNG Payload
          const dataUrl = rawCanvas.toDataURL('image/png');
          const maskB64 = dataUrl.split(',')[1];

          // Formulate Payload Structures
          const payload = {
            project: currentProject,
            clipId: clipId,
            maskB64: maskB64,
            inpaint: checkInpaint.checked,
            animations: animations,
            dilation: dilation
          };

          // Transmit Vector Parameters to Sequence Router
          const response = await fetch('/api/project/animate', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json'
            },
            body: JSON.stringify(payload)
          });

          if (!response.ok) {
            const errorText = await response.text();
            throw new Error(errorText || `HTTP Exception: Status code ${response.status}`);
          }

          const data = await response.json();
          
          // Complete Lifecycle Pipeline
          destroyOverlay();
          if (typeof onComplete === 'function') {
            onComplete(data.project);
          }
          
          showToast('Animation mask updated successfully.');
        } catch (error) {
          console.error('AnimateTool Save Failure:', error);
          spinner.classList.remove('visible');
          alert(`Failed to save animation settings:\n${error.message}`);
        }
      });

      // Internal Toast Notification Engine
      function showToast(message) {
        const toast = document.createElement('div');
        toast.textContent = message;
        toast.style.cssText = `
          position: fixed;
          bottom: 24px;
          right: 24px;
          background: #2b7336;
          color: #fff;
          padding: 12px 24px;
          border-radius: 4px;
          box-shadow: 0 4px 12px rgba(0,0,0,0.3);
          font-family: sans-serif;
          font-size: 14px;
          z-index: 100001;
          transition: opacity 0.3s ease;
        `;
        document.body.appendChild(toast);
        setTimeout(() => {
          toast.style.opacity = '0';
          setTimeout(() => {
            if (toast.parentNode) toast.parentNode.removeChild(toast);
          }, 300);
        }, 3000);
      }
    }
  };
})();