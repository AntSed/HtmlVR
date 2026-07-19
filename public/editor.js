(function() {
    "use strict";

    // Active project context from URL query parameter
    const urlParams = new URLSearchParams(window.location.search);
    let currentProject = urlParams.get('project');
    if (!currentProject) {
        currentProject = localStorage.getItem('htmlvr_current_project') || 'default';
        const newUrl = window.location.protocol + "//" + window.location.host + window.location.pathname + '?project=' + encodeURIComponent(currentProject);
        window.history.replaceState({ path: newUrl }, '', newUrl);
    }
    localStorage.setItem('htmlvr_current_project', currentProject);

    // Configuration
    let PX_PER_SECOND = 40; // Timeline scale: 1 second = 40 pixels
    let MAX_DURATION = 300; // Max project length in seconds (dynamic)
    const TIMELINE_OFFSET = 30; // Push timeline to the right to keep 0s clickable and prevent overlapping

    // State
    const project = {
        tracks: [], // { id, src, name, start, duration, trackIndex, compressTop, compressBottom }
        markers: [], // { time, text }
        trackConfigs: [
            { name: "Track 1" },
            { name: "Track 2" },
            { name: "Track 3" }
        ],
        masterCompressTop: 1.0,
        masterCompressBottom: 0.0
    };

    // Undo/Redo History Stacks
    const undoStack = [];
    const redoStack = [];
    const maxUndoLevels = 10;
    let rippleMode = 'off'; // 'off', 'track', 'all'
    let isRestoringState = false;

    function showToast(message) {
        let toast = document.querySelector('.toast-notification');
        if (!toast) {
            toast = document.createElement('div');
            toast.className = 'toast-notification';
            document.body.appendChild(toast);
        }
        toast.innerText = message;
        toast.classList.add('show');
        setTimeout(() => {
            toast.classList.remove('show');
        }, 3000);
    }

    function pushUndoState() {
        if (isRestoringState) return;
        const snapshot = JSON.parse(JSON.stringify(project));
        
        if (undoStack.length > 0) {
            const last = undoStack[undoStack.length - 1];
            if (JSON.stringify(last) === JSON.stringify(snapshot)) {
                return;
            }
        }
        
        undoStack.push(snapshot);
        if (undoStack.length > maxUndoLevels + 1) {
            undoStack.shift();
        }
        
        // Clear the redo stack whenever a new user action takes place
        redoStack.length = 0;
    }

    function undo() {
        if (undoStack.length <= 1) {
            console.log("Nothing to undo");
            return;
        }
        
        const current = undoStack.pop(); // Pop current state
        redoStack.push(current);         // Push to redo stack
        
        const prevState = undoStack[undoStack.length - 1];
        
        isRestoringState = true;
        project.tracks = JSON.parse(JSON.stringify(prevState.tracks || []));
        project.markers = JSON.parse(JSON.stringify(prevState.markers || []));
        project.trackConfigs = JSON.parse(JSON.stringify(prevState.trackConfigs || []));
        project.masterCompressTop = prevState.masterCompressTop !== undefined ? prevState.masterCompressTop : 1.0;
        project.masterCompressBottom = prevState.masterCompressBottom !== undefined ? prevState.masterCompressBottom : 0.0;
        
        rebuildTracksUI();
        updateProjectFromTimeline();
        isRestoringState = false;
        
        console.log("Undo successful. Stack sizes - Undo:", undoStack.length, "Redo:", redoStack.length);
    }

    function redo() {
        if (redoStack.length === 0) {
            console.log("Nothing to redo");
            return;
        }
        
        const nextState = redoStack.pop();
        
        isRestoringState = true;
        undoStack.push(nextState);
        
        project.tracks = JSON.parse(JSON.stringify(nextState.tracks || []));
        project.markers = JSON.parse(JSON.stringify(nextState.markers || []));
        project.trackConfigs = JSON.parse(JSON.stringify(nextState.trackConfigs || []));
        project.masterCompressTop = nextState.masterCompressTop !== undefined ? nextState.masterCompressTop : 1.0;
        project.masterCompressBottom = nextState.masterCompressBottom !== undefined ? nextState.masterCompressBottom : 0.0;
        
        rebuildTracksUI();
        updateProjectFromTimeline();
        isRestoringState = false;
        
        console.log("Redo successful. Stack sizes - Undo:", undoStack.length, "Redo:", redoStack.length);
    }

    const settings = {
        width: 1920,
        height: 1080,
        fps: 30,
        duration: MAX_DURATION
    };

    let isPlaying = false;
    let playheadTime = 0.0;
    let playStartTime = 0;
    let playStartPlayhead = 0;
    let animFrameId = null;
    let isDraggingPlayhead = false;
    let renderAbortController = null;

    let playheadMinTime = 0.0;
    let playheadMaxTime = 300.0;

    // DOM Elements
    const btnPlayPause = document.getElementById('btn-play-pause');
    const timeOut = document.getElementById('time-out');
    const playheadSlider = document.getElementById('playhead-slider');
    const assetList = document.getElementById('asset-list');
    const previewIframe = document.getElementById('preview-iframe');
    const btnSaveProject = document.getElementById('btn-save-project');
    const btnLoadProject = document.getElementById('btn-load-project');
    const btnRippleToggle = document.getElementById('btn-ripple-toggle');
    const btnSwitchProject = document.getElementById('btn-switch-project');
    const btnUndoProject = document.getElementById('btn-undo-project');
    const btnSendAgent = document.getElementById('btn-send-agent');
    const uploadZone = document.getElementById('upload-zone');
    const fileUploader = document.getElementById('file-uploader');
    const selectResolution = document.getElementById('select-resolution');
    const btnRender = document.getElementById('btn-render');
    const btnRenderCancel = document.getElementById('btn-render-cancel');
    const renderModal = document.getElementById('render-modal');
    const renderStatus = document.getElementById('render-status');
    const renderProgressFill = document.getElementById('render-progress-fill');
    const timelineRuler = document.getElementById('timeline-ruler');
    const tracksContainer = document.getElementById('timeline-tracks-container');
    const canvasContainer = document.getElementById('canvas-container');
    const btnFullscreen = document.getElementById('btn-fullscreen');

    const playhead = document.getElementById('playhead');
    const playheadHandle = playhead ? playhead.querySelector('.playhead-handle') : null;

    const btnRenderToggle = document.getElementById('btn-render-toggle');
    const renderDropdownMenu = document.getElementById('render-dropdown-menu');
    const commentModal = document.getElementById('comment-modal');
    const commentModalTitle = document.getElementById('comment-modal-title');
    const commentText = document.getElementById('comment-text');
    const btnCommentDelete = document.getElementById('btn-comment-delete');
    const btnCommentCancel = document.getElementById('btn-comment-cancel');
    const btnCommentSave = document.getElementById('btn-comment-save');

    // Clip Transform Properties Panel DOM Elements
    const clipPropertiesPanel = document.getElementById('clip-properties-panel');
    const assetsContainer = document.getElementById('assets-container');
    const btnCloseProperties = document.getElementById('btn-close-properties');
    const propScale = document.getElementById('prop-scale');
    const propScaleX = document.getElementById('prop-scalex');
    const propScaleY = document.getElementById('prop-scaley');
    const propPanX = document.getElementById('prop-panx');
    const propPanY = document.getElementById('prop-pany');
    const propScaleVal = document.getElementById('prop-scale-val');
    const propScaleXVal = document.getElementById('prop-scalex-val');
    const propScaleYVal = document.getElementById('prop-scaley-val');
    const propPanXVal = document.getElementById('prop-panx-val');
    const propPanYVal = document.getElementById('prop-pany-val');
    const propRotation = document.getElementById('prop-rotation');
    const propRotationVal = document.getElementById('prop-rotation-val');
    const propOpacity = document.getElementById('prop-opacity');
    const propOpacityVal = document.getElementById('prop-opacity-val');
    const propMirror = document.getElementById('prop-mirror');
    const btnResetTransform = document.getElementById('btn-reset-transform');

    // Transitions & Subproject Overrides DOM Elements
    const propTransInType = document.getElementById('prop-trans-in-type');
    const propTransInDuration = document.getElementById('prop-trans-in-duration');
    const propTransInDurationVal = document.getElementById('prop-trans-in-duration-val');
    const propTransOutType = document.getElementById('prop-trans-out-type');
    const propTransOutDuration = document.getElementById('prop-trans-out-duration');
    const propTransOutDurationVal = document.getElementById('prop-trans-out-duration-val');
    const subprojSettingsBlock = document.getElementById('subproj-settings-block');
    const propSubprojTransType = document.getElementById('prop-subproj-trans-type');
    const propSubprojTransDuration = document.getElementById('prop-subproj-trans-duration');
    const propSubprojTransDurationVal = document.getElementById('prop-subproj-trans-duration-val');
    const propSubprojTransOverride = document.getElementById('prop-subproj-trans-override');

    // Animation Settings DOM Elements
    const animSettingsBlock = document.getElementById('anim-settings-block');
    const propAnimType = document.getElementById('prop-anim-type');
    const propAnimEasing = document.getElementById('prop-anim-easing');
    const propAnimStart = document.getElementById('prop-anim-start');
    const propAnimStartVal = document.getElementById('prop-anim-start-val');
    const propAnimEnd = document.getElementById('prop-anim-end');
    const propAnimEndVal = document.getElementById('prop-anim-end-val');
    const propAnimDir = document.getElementById('prop-anim-dir');
    const propAnimDirVal = document.getElementById('prop-anim-dir-val');
    const propAnimAmp = document.getElementById('prop-anim-amp');
    const propAnimAmpVal = document.getElementById('prop-anim-amp-val');
    const propAnimFreq = document.getElementById('prop-anim-freq');
    const propAnimFreqVal = document.getElementById('prop-anim-freq-val');
    const propAnimPivotX = document.getElementById('prop-anim-pivot-x');
    const propAnimPivotXVal = document.getElementById('prop-anim-pivot-x-val');
    const propAnimPivotY = document.getElementById('prop-anim-pivot-y');
    const propAnimPivotYVal = document.getElementById('prop-anim-pivot-y-val');

    // Viewport Active Outline Manipulation Elements
    const viewportActiveOutline = document.getElementById('viewport-active-outline');
    const viewportOutlineLabel = document.getElementById('viewport-outline-label');

    // Project modal elements
    const projectModal = document.getElementById('project-modal');
    const projectListContainer = document.getElementById('project-list-container');
    const customProjectInput = document.getElementById('custom-project-input');
    const btnProjectGo = document.getElementById('btn-project-go');
    const btnProjectCancel = document.getElementById('btn-project-cancel');

    // Initialize Ruler Ticks
    function initRuler() {
        timelineRuler.innerHTML = '';
        const width = MAX_DURATION * PX_PER_SECOND + TIMELINE_OFFSET;
        timelineRuler.style.width = `${width}px`;
        const rows = document.querySelectorAll('.track-row');
        rows.forEach(row => row.style.width = `${width}px`);

        let tickStep = 1;
        let labelStep = 5;

        const tickWidths = [1, 2, 5, 10, 30, 60, 120, 300, 600, 1800, 3600];
        for (const step of tickWidths) {
            if (step * PX_PER_SECOND >= 8) {
                tickStep = step;
                break;
            }
            tickStep = step;
        }

        const labelWidths = [5, 10, 30, 60, 120, 300, 600, 1800, 3600];
        for (const step of labelWidths) {
            if (step * PX_PER_SECOND >= 45) {
                labelStep = step;
                break;
            }
            labelStep = step;
        }

        for (let i = 0; i <= MAX_DURATION; i += tickStep) {
            const isMajor = (i % labelStep === 0);
            const tick = document.createElement('div');
            tick.className = `ruler-tick ${isMajor ? 'major' : ''}`;
            tick.style.left = `${TIMELINE_OFFSET + i * PX_PER_SECOND}px`;
            timelineRuler.appendChild(tick);

            if (isMajor) {
                const label = document.createElement('div');
                label.className = 'ruler-label';
                label.style.left = `${TIMELINE_OFFSET + i * PX_PER_SECOND}px`;
                
                let labelText = `${i}s`;
                if (i >= 60) {
                    const m = Math.floor(i / 60);
                    const s = i % 60;
                    labelText = s === 0 ? `${m}m` : `${m}m${s}s`;
                }
                label.innerText = labelText;
                timelineRuler.appendChild(label);
            }
        }
        renderMarkers();
    }

    // Active comment modal state
    let activeCommentIndex = -1;
    let activeCommentTime = 0.0;
    let lastFetchedStateStr = "";

    // Render Markers on Ruler
    function renderMarkers() {
        const oldMarkers = timelineRuler.querySelectorAll('.timeline-marker');
        oldMarkers.forEach(m => m.remove());

        if (!project.markers) {
            project.markers = [];
        }

        project.markers.forEach((marker, index) => {
            const markerEl = document.createElement('div');
            markerEl.className = 'timeline-marker';
            markerEl.style.left = `${TIMELINE_OFFSET + marker.time * PX_PER_SECOND}px`;
            
            const pin = document.createElement('div');
            pin.className = 'marker-pin';
            markerEl.appendChild(pin);

            const tooltip = document.createElement('div');
            tooltip.className = 'marker-tooltip';
            tooltip.innerText = marker.text;
            markerEl.appendChild(tooltip);

            markerEl.addEventListener('mouseenter', () => {
                // Get stable bounds
                const markerRect = markerEl.getBoundingClientRect();
                const containerRect = tracksContainer.getBoundingClientRect();
                
                // Get tooltip width (stable, width is not animated)
                const tooltipRect = tooltip.getBoundingClientRect();
                const tooltipWidth = tooltipRect.width;
                
                // Calculate ideal centered position
                const markerCenter = markerRect.left + markerRect.width / 2;
                const idealLeft = markerCenter - tooltipWidth / 2;
                const idealRight = markerCenter + tooltipWidth / 2;
                
                // Clamp horizontal position so it stays visible and does not slide under the left track header column
                const leftLimit = containerRect.left + 5;
                const rightLimit = containerRect.right - 5;
                
                if (idealLeft < leftLimit) {
                    const diff = leftLimit - idealLeft;
                    tooltip.style.setProperty('--tooltip-x', `calc(-50% + ${diff}px)`);
                } else if (idealRight > rightLimit) {
                    const diff = rightLimit - idealRight;
                    tooltip.style.setProperty('--tooltip-x', `calc(-50% + ${diff}px)`);
                } else {
                    tooltip.style.setProperty('--tooltip-x', '-50%');
                }
            });

            markerEl.addEventListener('mousedown', (e) => {
                e.stopPropagation();
            });

            markerEl.addEventListener('click', (e) => {
                e.stopPropagation();
                seekTo(marker.time);
                openCommentModal(index, null);
            });

            timelineRuler.appendChild(markerEl);
        });
    }

    // Open Custom Comment Modal
    function openCommentModal(index, time) {
        if (index !== null && index !== undefined) {
            activeCommentIndex = index;
            const marker = project.markers[activeCommentIndex];
            activeCommentTime = marker.time;
            commentModalTitle.innerText = `Edit Comment at ${activeCommentTime.toFixed(2)}s`;
            commentText.value = marker.text;
            btnCommentDelete.style.display = 'block';
        } else {
            activeCommentIndex = -1;
            activeCommentTime = parseFloat(time);
            commentModalTitle.innerText = `Add Comment at ${activeCommentTime.toFixed(2)}s`;
            commentText.value = '';
            btnCommentDelete.style.display = 'none';
        }
        commentModal.style.display = 'flex';
        commentText.focus();
    }

    function closeCommentModal() {
        commentModal.style.display = 'none';
        activeCommentIndex = -1;
    }

    async function getProjectDuration(projName) {
        try {
            const res = await fetch(`/api/project/state?project=${encodeURIComponent(projName)}`);
            if (!res.ok) return 10;
            const data = await res.json();
            let maxTime = 10;
            if (data.tracks && data.tracks.length > 0) {
                data.tracks.forEach(track => {
                    const end = (track.start || 0) + (track.duration || 0);
                    if (end > maxTime) {
                        maxTime = end;
                    }
                });
            }
            return maxTime;
        } catch (e) {
            console.error("Error fetching project duration:", e);
            return 10;
        }
    }

    async function checkAndUpdateSubprojectDurations() {
        let changed = false;
        const tracks = project.tracks || [];
        for (let track of tracks) {
            if (track.src && track.src.startsWith('project:')) {
                const subProjName = track.src.substring(8);
                const actDuration = await getProjectDuration(subProjName);
                const diff = actDuration - track.duration;
                
                if (Math.abs(diff) > 0.01) {
                    const oldEnd = track.start + track.duration;
                    track.duration = actDuration;
                    
                    // Ripple Edit: shift all clips starting at or after oldEnd
                    tracks.forEach(otherTrack => {
                        if (otherTrack.id !== track.id && otherTrack.start >= oldEnd - 0.05) {
                            otherTrack.start += diff;
                        }
                    });
                    changed = true;
                }
            }
        }
        
        if (changed) {
            rebuildTracksUI();
            updateProjectFromTimeline();
            showToast("Subproject durations updated, ripple edit applied.");
        }
    }

    async function groupSelectedClips() {
        const selectedBlocks = Array.from(document.querySelectorAll('.timeline-block.active'));
        if (selectedBlocks.length < 2) {
            showToast("Select 2 or more clips to group them.");
            return;
        }

        // Gather clips from the active state
        const clipIds = selectedBlocks.map(b => b.dataset.id);
        const selectedClips = project.tracks.filter(t => clipIds.includes(t.id));

        if (selectedClips.length === 0) {
            showToast("Error finding selected clips in project state.");
            return;
        }

        // Calculate start and end bounds
        let minStart = Infinity;
        let maxEnd = -Infinity;
        selectedClips.forEach(c => {
            if (c.start < minStart) minStart = c.start;
            const end = c.start + c.duration;
            if (end > maxEnd) maxEnd = end;
        });

        const groupDuration = maxEnd - minStart;
        if (groupDuration <= 0) {
            showToast("Invalid group duration.");
            return;
        }

        // Generate nested subproject state with adjusted start offsets
        const subprojectTracks = selectedClips.map(clip => ({
            ...clip,
            start: clip.start - minStart
        }));

        const subprojectState = {
            tracks: subprojectTracks,
            duration: groupDuration,
            markers: [],
            trackConfigs: project.trackConfigs || [{ name: "Track 1" }, { name: "Track 2" }, { name: "Track 3" }]
        };

        const subprojectId = `subproj_${Date.now()}`;
        const subprojectName = `${currentProject}/${subprojectId}`;

        showToast("Creating subproject...");

        try {
            // Save subproject state to the server
            const res = await fetch(`/api/project/state?project=${encodeURIComponent(subprojectName)}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(subprojectState)
            });

            if (!res.ok) {
                throw new Error("Server failed to save subproject state.");
            }

            // Remove selected clips from the parent tracks list
            project.tracks = project.tracks.filter(t => !clipIds.includes(t.id));

            // Determine highest-priority track index (top-most in index)
            const minTrackIndex = Math.min(...selectedClips.map(c => c.trackIndex));

            // Create new subproject clip referencing the newly created nested project
            const newSubprojectClip = {
                id: `clip_${Date.now()}_${Math.floor(Math.random()*1000)}`,
                src: `project:${subprojectName}`,
                name: `Group: ${selectedClips.length} clips`,
                start: minStart,
                duration: groupDuration,
                trackIndex: minTrackIndex,
                fadeIn: 0.0,
                fadeOut: 0.0,
                compressTop: 1.0,
                compressBottom: 0.0,
                panX: 0,
                panY: 0,
                scale: 1.0,
                scaleX: 1.0,
                scaleY: 1.0,
                rotation: 0,
                opacity: 1.0,
                transitionIn: 'none',
                transitionOut: 'none',
                subprojDefaultTransition: 'none',
                subprojTransitionDuration: 0.5,
                subprojTransitionOverride: 'empty'
            };

            project.tracks.push(newSubprojectClip);

            // Rebuild the timeline visual representation
            rebuildTracksUI();
            updateProjectFromTimeline();
            showToast("Group created successfully! Double-click to edit.");

        } catch (err) {
            console.error("Failed to group selection:", err);
            showToast("Grouping failed: " + err.message);
        }
    }

    async function ungroupSelectedClips() {
        const selectedBlocks = Array.from(document.querySelectorAll('.timeline-block.active'));
        if (selectedBlocks.length !== 1) return;
        
        const activeBlock = selectedBlocks[0];
        const src = activeBlock.dataset.src;
        if (!src || !src.startsWith('project:')) return;
        
        const subprojectName = src.substring(8);
        const groupStart = parseFloat(activeBlock.dataset.start);
        const groupClipId = activeBlock.dataset.id;
        
        showToast("Expanding subproject...");
        
        try {
            // Fetch subproject state
            const res = await fetch(`/api/project/state?project=${encodeURIComponent(subprojectName)}`);
            if (!res.ok) {
                throw new Error("Failed to load subproject state.");
            }
            
            const subproject = await res.json();
            const innerTracks = subproject.tracks || [];
            
            if (innerTracks.length === 0) {
                showToast("Subproject has no clips to expand.");
                return;
            }
            
            // Map inner clips absolute start times
            const resolvedInnerClips = innerTracks.map(clip => ({
                ...clip,
                id: `clip_${Date.now()}_${Math.floor(Math.random()*10000)}`, // generate new unique ID
                start: groupStart + clip.start
            }));
            
            // Remove the parent subproject clip
            project.tracks = project.tracks.filter(t => t.id !== groupClipId);
            
            // Check for track collisions and shift colliding parent clips to new tracks
            resolvedInnerClips.forEach(innerClip => {
                const innerEnd = innerClip.start + innerClip.duration;
                
                // Find parent clips on the same track index that overlap in time
                project.tracks.forEach(parentClip => {
                    if (parentClip.trackIndex === innerClip.trackIndex) {
                        const parentEnd = parentClip.start + parentClip.duration;
                        const hasOverlap = (innerClip.start < parentEnd - 0.05) && (parentClip.start < innerEnd - 0.05);
                        
                        if (hasOverlap) {
                            // Find the next completely new track index
                            const maxTrackIndex = Math.max(...project.tracks.map(t => t.trackIndex), project.trackConfigs.length - 1);
                            const newTrackIndex = maxTrackIndex + 1;
                            
                            parentClip.trackIndex = newTrackIndex;
                            
                            // Ensure trackConfigs has this index
                            while (project.trackConfigs.length <= newTrackIndex) {
                                project.trackConfigs.push({ name: `Track ${project.trackConfigs.length + 1}` });
                            }
                            console.log(`Shifted colliding parent clip ${parentClip.id} to new track index ${newTrackIndex}`);
                        }
                    }
                });
                
                // Add the resolved clip to the parent tracks
                project.tracks.push(innerClip);
            });
            
            // Optional: call delete API (ignores error since it's outside compositionsDir)
            fetch(`/api/delete?name=project_state.json&project=${encodeURIComponent(subprojectName)}`, {
                method: 'DELETE'
            }).catch(e => console.warn("Failed to delete subproject file on ungroup:", e));
            
            // Rebuild UI and save state
            rebuildTracksUI();
            updateProjectFromTimeline();
            showToast("Subproject expanded successfully!");
            
        } catch (err) {
            console.error("Failed to ungroup subproject:", err);
            showToast("Ungroup failed: " + err.message);
        }
    }

    function updateToolbarButtonsState() {
        const selectedBlocks = Array.from(document.querySelectorAll('.timeline-block.active'));
        const btnGroupSelection = document.getElementById('btn-group-selection');
        if (!btnGroupSelection) return;

        if (selectedBlocks.length === 1 && selectedBlocks[0].dataset.src && selectedBlocks[0].dataset.src.startsWith('project:')) {
            // Change button to "Ungroup"
            btnGroupSelection.innerHTML = `
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#ef4444" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M22 5a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V5z"/>
                    <line x1="9" y1="12" x2="15" y2="12"/>
                </svg>
                Ungroup
            `;
            btnGroupSelection.title = "Ungroup/Expand clips from this subproject";
            btnGroupSelection.style.borderColor = "#ef4444";
            btnGroupSelection.style.color = "#ef4444";
            btnGroupSelection.dataset.mode = "ungroup";
        } else {
            // Reset to "Group"
            btnGroupSelection.innerHTML = `
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#f59e0b" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2 2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
                    <line x1="12" y1="11" x2="12" y2="17"/>
                    <line x1="9" y1="14" x2="15" y2="14"/>
                </svg>
                Group
            `;
            btnGroupSelection.title = "Group selected clips into a Subproject";
            btnGroupSelection.style.borderColor = "#f59e0b";
            btnGroupSelection.style.color = "#f59e0b";
            btnGroupSelection.dataset.mode = "group";
        }
    }

    // Load Available Compositions
    async function loadCompositions() {
        try {
            const res = await fetch(`/api/compositions?project=${encodeURIComponent(currentProject)}`);
            const files = await res.json();
            
            assetList.innerHTML = '';
            files.forEach(file => {
                const li = document.createElement('li');
                li.className = 'asset-item';
                li.draggable = true;
                
                let fileName = "";
                let fileSrc = "";
                if (typeof file === 'object' && file !== null) {
                    fileName = file.name;
                    fileSrc = file.src;
                } else {
                    fileName = file;
                    fileSrc = `projects/${currentProject}/compositions/${file}`;
                }
                
                li.dataset.src = fileSrc;
                
                const label = document.createElement('span');
                label.innerText = fileName;
                label.style.textOverflow = 'ellipsis';
                label.style.overflow = 'hidden';
                label.style.whiteSpace = 'nowrap';
                label.style.flexGrow = '1';
                li.appendChild(label);

                const deleteBtn = document.createElement('button');
                deleteBtn.className = 'asset-delete-btn';
                deleteBtn.innerHTML = '&times;';
                deleteBtn.title = 'Delete asset';
                deleteBtn.addEventListener('click', async (e) => {
                    e.stopPropagation();
                    e.preventDefault();
                    if (confirm(`Are you sure you want to delete ${fileName}?`)) {
                        try {
                            const delRes = await fetch(`/api/delete?name=${encodeURIComponent(fileName)}&project=${encodeURIComponent(currentProject)}`, {
                                method: 'DELETE'
                            });
                            const delResult = await delRes.json();
                            if (delResult.success) {
                                loadCompositions();
                            } else {
                                alert("Failed to delete asset: " + delResult.error);
                            }
                        } catch(err) {
                            alert("Error deleting asset: " + err.message);
                        }
                    }
                });
                li.appendChild(deleteBtn);
                
                li.addEventListener('dragstart', (e) => {
                    e.dataTransfer.setData('text/plain', JSON.stringify({
                        src: fileSrc,
                        name: fileName
                    }));
                });
                assetList.appendChild(li);
            });
        } catch(e) {
            console.error("Failed to load compositions list:", e);
        }
    }

    // Update playhead vertical height and scroll translation
    function updatePlayheadVertical() {
        if (playhead && tracksContainer) {
            const scrollTop = tracksContainer.scrollTop;
            playhead.style.transform = `translate3d(-50%, ${scrollTop}px, 0)`;
            playhead.style.height = `${tracksContainer.clientHeight}px`;
        }
    }

    // Set playhead visual marker
    function setPlayheadVisual(time) {
        const left = TIMELINE_OFFSET + time * PX_PER_SECOND;
        tracksContainer.style.setProperty('--playhead-left', `${left}px`);
        
        // Update slider input value
        playheadSlider.value = time;

        // Update time display code (HH:MM.mmm)
        const mins = Math.floor(time / 60).toString().padStart(2, '0');
        const secs = Math.floor(time % 60).toString().padStart(2, '0');
        const ms = Math.floor((time % 1) * 1000).toString().padStart(3, '0');
        timeOut.innerText = `${mins}:${secs}.${ms}`;
        
        updatePlayheadVertical();
    }

    // Propagate time changes to iframe content
    function syncIframeSeek(time, isJump = false) {
        if (previewIframe && previewIframe.contentWindow) {
            try {
                if (typeof previewIframe.contentWindow.seekTo === 'function') {
                    previewIframe.contentWindow.seekTo(time, isJump);
                }
            } catch(e) {}
        }
    }

    // Seek Project Playhead
    function seekTo(time, isPlaybackStep = false) {
        playheadTime = Math.max(playheadMinTime, Math.min(playheadMaxTime, time));
        setPlayheadVisual(playheadTime);
        syncIframeSeek(playheadTime, !isPlaybackStep);
        
        // Update selection overlay outline visibility/position
        updateViewportOutline();
        
        if (!isPlaybackStep && isPlaying) {
            playStartTime = performance.now();
            playStartPlayhead = playheadTime;
        }
    }

    // Playback loop
    function updatePlayback() {
        if (!isPlaying) return;

        const elapsed = (performance.now() - playStartTime) / 1000;
        let newTime = playStartPlayhead + elapsed;

        if (newTime >= playheadMaxTime || newTime < playheadMinTime) {
            newTime = playheadMinTime;
            playStartTime = performance.now();
            playStartPlayhead = playheadMinTime;
        }

        seekTo(newTime, true);
        animFrameId = requestAnimationFrame(updatePlayback);
    }

    // Toggle Play/Pause
    function togglePlay() {
        if (isPlaying) {
            isPlaying = false;
            btnPlayPause.innerText = 'PLAY';
            cancelAnimationFrame(animFrameId);
            resetVolumeMeters();
            try {
                if (previewIframe && previewIframe.contentWindow) {
                    if (typeof previewIframe.contentWindow.setPlaybackState === 'function') {
                        previewIframe.contentWindow.setPlaybackState(false);
                    }
                }
            } catch(e) {}
        } else {
            isPlaying = true;
            btnPlayPause.innerText = 'PAUSE';
            playStartTime = performance.now();
            playStartPlayhead = playheadTime;
            
            // Resume parent context on play gesture to satisfy chrome policy
            if (window.audioCtx && window.audioCtx.state === 'suspended') {
                window.audioCtx.resume().catch(e => console.warn("Failed to resume parent audioCtx:", e));
            }
            
            try {
                if (previewIframe && previewIframe.contentWindow) {
                    if (typeof previewIframe.contentWindow.setPlaybackState === 'function') {
                        previewIframe.contentWindow.setPlaybackState(true);
                    }
                }
            } catch(e) {}

            updatePlayback();
        }
    }

    window.togglePlay = togglePlay;

    let lufsHistory = [];
    let lastLufsSampleTime = 0;
    let maxPeakL = 0.0;
    let maxPeakR = 0.0;

    function formatPeakDb(amp) {
        if (amp <= 0.01) return "-inf";
        const db = 20 * Math.log10(amp);
        return (db > 0 ? "+" : "") + db.toFixed(1);
    }

    function updateVolumeMeters() {
        if (!previewIframe || !previewIframe.contentWindow) return;
        
        const panel = document.getElementById('master-meter-panel');
        if (!panel || panel.classList.contains('collapsed')) return;

        try {
            if (typeof previewIframe.contentWindow.getMasterLevels === 'function') {
                const levels = previewIframe.contentWindow.getMasterLevels();
                
                if (levels.l.peak > maxPeakL) maxPeakL = levels.l.peak;
                if (levels.r.peak > maxPeakR) maxPeakR = levels.r.peak;
                
                const peaksText = document.getElementById('master-meter-peaks');
                if (peaksText) {
                    peaksText.innerText = `L:${formatPeakDb(maxPeakL)} R:${formatPeakDb(maxPeakR)}`;
                }

                animateVUChannel('l', levels.l);
                animateVUChannel('r', levels.r);
                
                // Sample LUFS rolling RMS every 100ms
                const now = performance.now();
                if (now - lastLufsSampleTime >= 100) {
                    lastLufsSampleTime = now;
                    
                    const avgRms = (levels.l.rms + levels.r.rms) / 2;
                    lufsHistory.push(avgRms);
                    
                    if (lufsHistory.length > 100) {
                        lufsHistory.shift();
                    }
                    
                    let sumSq = 0;
                    lufsHistory.forEach(val => {
                        sumSq += val * val;
                    });
                    const rollingRms = Math.sqrt(sumSq / (lufsHistory.length || 1));
                    const lufsPercent = ampToDbPercent(rollingRms);
                    
                    const lufsInd = document.getElementById('master-meter-lufs');
                    if (lufsInd) {
                        lufsInd.style.bottom = `${lufsPercent}%`;
                    }
                }
            }
        } catch (err) {
            // Ignore frame cross-origin access during transitions
        }
    }

    function ampToDbPercent(amp) {
        if (amp <= 0.01) return 0; // -40 dB is 0.01 linear amplitude
        const db = 20 * Math.log10(amp);
        const percent = ((db + 40) / 40) * 100;
        return Math.min(100, Math.max(0, percent));
    }
    window.ampToDbPercent = ampToDbPercent;

    function dbPercentToAmp(percent) {
        const db = (percent / 100) * 40 - 40;
        return Math.pow(10, db / 20);
    }
    window.dbPercentToAmp = dbPercentToAmp;

    function animateVUChannel(channelId, level) {
        const fill = document.getElementById(`master-meter-${channelId}`);
        const peakLine = document.getElementById(`master-meter-peak-${channelId}`);
        if (!fill || !peakLine) return;
        
        const rmsHeight = ampToDbPercent(level.rms);
        const peakHeight = ampToDbPercent(level.peak);
        
        fill.style.height = `${rmsHeight}%`;
        
        const currentPeak = parseFloat(peakLine.dataset.peakVal || 0);
        let finalPeak = peakHeight;
        if (finalPeak < currentPeak) {
            finalPeak = currentPeak - 1.8; // smooth slow decay
        }
        finalPeak = Math.max(0, finalPeak);
        peakLine.dataset.peakVal = finalPeak;
        peakLine.style.bottom = `${finalPeak}%`;
    }

    function resetVolumeMeters() {
        ['l', 'r'].forEach(ch => {
            const fill = document.getElementById(`master-meter-${ch}`);
            const peakLine = document.getElementById(`master-meter-peak-${ch}`);
            if (fill) fill.style.height = '0%';
            if (peakLine) {
                peakLine.dataset.peakVal = 0;
                peakLine.style.bottom = '0%';
            }
        });
    }

    async function normalizeTrackClips(trackIndex) {
        const trackClips = project.tracks.filter(clip => parseInt(clip.trackIndex) === trackIndex);
        const audioClips = trackClips.filter(clip => {
            const src = clip.src.toLowerCase();
            return src.endsWith('.wav') || src.endsWith('.mp3') || src.endsWith('.ogg');
        });
        if (audioClips.length === 0) {
            showToast("No audio clips found on this track to normalize.");
            return;
        }

        const normBtn = document.querySelector(`.track-header[data-track-index="${trackIndex}"] .track-header-normalize`);
        if (normBtn) normBtn.classList.add('active');

        showToast("Analyzing track audio levels...");
        try {
            const promises = audioClips.map(async clip => {
                try {
                    const data = await window.AudioVisualizer.getAudioData(clip.src);
                    return { clip, rms: data.rms };
                } catch (err) {
                    console.error("Failed to decode RMS for clip:", clip.src, err);
                    return { clip, rms: null };
                }
            });
            const results = await Promise.all(promises);

            pushUndoState();
            
            const targetRms = 0.1259; // -18 dB Target
            let adjustedCount = 0;

            results.forEach(({ clip, rms }) => {
                if (rms === null || rms === undefined) return;
                
                const multiplier = targetRms / rms;
                let cTop = 1.0;
                let cBot = 0.0;
                
                if (multiplier <= 1.0) {
                    cTop = Math.max(0.1, multiplier);
                    cBot = 0.0;
                } else {
                    cTop = 1.0;
                    cBot = Math.min(1.0, (multiplier - 1.0) / 4.0);
                }
                
                clip.compressTop = parseFloat(cTop.toFixed(3));
                clip.compressBottom = parseFloat(cBot.toFixed(3));
                adjustedCount++;
                
                const blockEl = document.querySelector(`[data-id="${clip.id}"]`);
                if (blockEl) {
                    blockEl.dataset.compressTop = clip.compressTop;
                    blockEl.dataset.compressBottom = clip.compressBottom;
                    if (typeof blockEl.updateSqueezeVisuals === 'function') {
                        blockEl.updateSqueezeVisuals();
                    }
                }
            });

            rebuildTracksUI();
            updateProjectFromTimeline(true);
            showToast(`Successfully normalized ${adjustedCount} clips on Track ${trackIndex + 1}!`);
        } catch (err) {
            console.error("Normalization failed:", err);
            showToast("Failed to normalize track audio.");
        } finally {
            if (normBtn) normBtn.classList.remove('active');
        }
    }

    // Rebuild preview iframe URL containing current project configuration
    function updatePreviewSource() {
        const cleanTracks = project.tracks.map(t => ({
            id: t.id,
            src: t.src,
            start: t.start,
            duration: t.duration,
            trackIndex: t.trackIndex,
            fadeIn: t.fadeIn || 0,
            fadeOut: t.fadeOut || 0,
            compressTop: t.compressTop !== undefined ? t.compressTop : 1.0,
            compressBottom: t.compressBottom !== undefined ? t.compressBottom : 0.0,
            panX: t.panX !== undefined ? t.panX : 0,
            panY: t.panY !== undefined ? t.panY : 0,
            scale: t.scale !== undefined ? t.scale : 1.0,
            scaleX: t.scaleX !== undefined ? t.scaleX : (t.scale !== undefined ? t.scale : 1.0),
            scaleY: t.scaleY !== undefined ? t.scaleY : (t.scale !== undefined ? t.scale : 1.0),
            rotation: t.rotation !== undefined ? t.rotation : 0,
            opacity: t.opacity !== undefined ? t.opacity : 1.0,
            transitionIn: t.transitionIn || 'none',
            transitionOut: t.transitionOut || 'none',
            subprojDefaultTransition: t.subprojDefaultTransition || 'none',
            subprojTransitionDuration: t.subprojTransitionDuration !== undefined ? t.subprojTransitionDuration : 0.5,
            subprojTransitionOverride: t.subprojTransitionOverride || 'empty',
            mirror: t.mirror || false,
            animate_tool: t.animate_tool
        }));
        
        const projectBase64 = btoa(unescape(encodeURIComponent(JSON.stringify({ 
            tracks: cleanTracks, 
            trackConfigs: project.trackConfigs 
        }))));
        
        let w = settings.width;
        let h = settings.height;
        if (selectResolution) {
            const resStr = selectResolution.value;
            if (resStr) {
                const parts = resStr.split('x').map(x => parseInt(x));
                if (parts.length === 2 && !isNaN(parts[0]) && !isNaN(parts[1])) {
                    w = parts[0];
                    h = parts[1];
                }
            }
        }
        
        previewIframe.src = `/render-host.html?project_name=${encodeURIComponent(currentProject)}&width=${w}&height=${h}&t=${Date.now()}`;
        
        // Wait briefly for load, then seek to current playhead position
        previewIframe.onload = () => {
            syncIframeSeek(playheadTime);
            try {
                if (previewIframe.contentWindow && typeof previewIframe.contentWindow.setPlaybackState === 'function') {
                    previewIframe.contentWindow.setPlaybackState(isPlaying);
                }
            } catch(e) {}
            propagateTrackVolumesToPreview();
            propagateTrackSelectionToPreview();
            propagateMasterLimiterToPreview();
        };
    }

    let previewUpdateTimeout = null;
    function debouncedUpdatePreviewSource() {
        if (previewUpdateTimeout) {
            clearTimeout(previewUpdateTimeout);
        }
        previewUpdateTimeout = setTimeout(() => {
            updatePreviewSource();
        }, 500);
    }

    function updatePlayheadSliderRange() {
        playheadSlider.min = playheadMinTime;
        playheadSlider.max = playheadMaxTime;

        if (playheadTime < playheadMinTime) {
            seekTo(playheadMinTime);
        } else if (playheadTime > playheadMaxTime) {
            seekTo(playheadMaxTime);
        }
    }

    function recalculateTimelineDuration() {
        const blocks = document.querySelectorAll('.timeline-block');
        let maxTime = 60;
        let minTime = 0;

        if (blocks.length > 0) {
            let firstStart = Infinity;
            let lastEnd = -Infinity;
            blocks.forEach(block => {
                const start = parseFloat(block.dataset.start) || 0;
                const duration = parseFloat(block.dataset.duration) || 0;
                const end = start + duration;
                if (start < firstStart) firstStart = start;
                if (end > lastEnd) lastEnd = end;
            });
            if (firstStart !== Infinity) minTime = firstStart;
            if (lastEnd !== -Infinity) maxTime = lastEnd;
        }

        playheadMinTime = minTime;
        playheadMaxTime = maxTime;

        MAX_DURATION = Math.max(60, Math.ceil((maxTime + 30) / 10) * 10);

        const width = MAX_DURATION * PX_PER_SECOND + TIMELINE_OFFSET;
        timelineRuler.style.width = `${width}px`;
        const rows = document.querySelectorAll('.track-row');
        rows.forEach(row => row.style.width = `${width}px`);

        initRuler();
        updatePlayheadSliderRange();
    }

    function adjustTimelineDurationDuringInteraction(maxEndTimeNeeded) {
        if (maxEndTimeNeeded > MAX_DURATION) {
            MAX_DURATION = Math.ceil(maxEndTimeNeeded) + 60;
            
            const width = MAX_DURATION * PX_PER_SECOND + TIMELINE_OFFSET;
            timelineRuler.style.width = `${width}px`;
            const rows = document.querySelectorAll('.track-row');
            rows.forEach(row => row.style.width = `${width}px`);
            
            initRuler();
        }
        
        const blocks = document.querySelectorAll('.timeline-block');
        let firstStart = Infinity;
        let lastEnd = -Infinity;
        blocks.forEach(block => {
            const start = parseFloat(block.dataset.start) || 0;
            const duration = parseFloat(block.dataset.duration) || 0;
            const end = start + duration;
            if (start < firstStart) firstStart = start;
            if (end > lastEnd) lastEnd = end;
        });
        if (firstStart !== Infinity) playheadMinTime = firstStart;
        if (lastEnd !== -Infinity) playheadMaxTime = lastEnd;
        
        updatePlayheadSliderRange();
    }

    // Update Project state structure from DOM timeline positions
    function updateProjectFromTimeline(skipReload = false) {
        project.tracks = [];
        const blocks = document.querySelectorAll('.timeline-block');
        blocks.forEach(block => {
            project.tracks.push({
                id: block.dataset.id,
                src: block.dataset.src,
                name: block.dataset.name,
                start: parseFloat(block.dataset.start),
                duration: parseFloat(block.dataset.duration),
                sourceStart: block.dataset.sourceStart !== undefined ? parseFloat(block.dataset.sourceStart) : 0.0,
                trackIndex: parseInt(block.dataset.trackIndex),
                fadeIn: parseFloat(block.dataset.fadeIn) || 0,
                fadeOut: parseFloat(block.dataset.fadeOut) || 0,
                compressTop: block.dataset.compressTop !== undefined ? parseFloat(block.dataset.compressTop) : 1.0,
                compressBottom: block.dataset.compressBottom !== undefined ? parseFloat(block.dataset.compressBottom) : 0.0,
                panX: block.dataset.panX !== undefined ? parseFloat(block.dataset.panX) : 0,
                panY: block.dataset.panY !== undefined ? parseFloat(block.dataset.panY) : 0,
                scale: block.dataset.scale !== undefined ? parseFloat(block.dataset.scale) : 1.0,
                scaleX: block.dataset.scaleX !== undefined ? parseFloat(block.dataset.scaleX) : (block.dataset.scale !== undefined ? parseFloat(block.dataset.scale) : 1.0),
                scaleY: block.dataset.scaleY !== undefined ? parseFloat(block.dataset.scaleY) : (block.dataset.scale !== undefined ? parseFloat(block.dataset.scale) : 1.0),
                rotation: block.dataset.rotation !== undefined ? parseFloat(block.dataset.rotation) : 0,
                opacity: block.dataset.opacity !== undefined ? parseFloat(block.dataset.opacity) : 1.0,
                transitionIn: block.dataset.transitionIn || 'none',
                transitionOut: block.dataset.transitionOut || 'none',
                subprojDefaultTransition: block.dataset.subprojDefaultTransition || 'none',
                subprojTransitionDuration: block.dataset.subprojTransitionDuration !== undefined ? parseFloat(block.dataset.subprojTransitionDuration) : 0.5,
                subprojTransitionOverride: block.dataset.subprojTransitionOverride || 'empty',
                mirror: block.dataset.mirror === "true",
                animate_tool: block.dataset.animateTool ? JSON.parse(block.dataset.animateTool) : undefined,
                volumePoints: block.dataset.volumePoints ? JSON.parse(block.dataset.volumePoints) : undefined
            });
        });
        recalculateTimelineDuration();
        
        let needsFullReload = false;
        if (!skipReload) {
            if (previewIframe && previewIframe.contentWindow) {
                try {
                    const hostWindow = previewIframe.contentWindow;
                    const hostDoc = previewIframe.contentDocument || hostWindow.document;
                    
                    if (hostWindow.project) {
                        hostWindow.project.tracks = JSON.parse(JSON.stringify(project.tracks));
                    }
                    
                    const blockIds = new Set();
                    blocks.forEach(block => {
                        const blockId = block.dataset.id;
                        blockIds.add(blockId);
                        const hostEl = hostDoc.querySelector(`[data-id="${blockId}"]`);
                        if (!hostEl) {
                            needsFullReload = true; // New element, needs full reload to generate
                        } else {
                            // Sync properties directly
                            hostEl.dataset.start = block.dataset.start;
                            hostEl.dataset.duration = block.dataset.duration;
                            hostEl.dataset.sourceStart = block.dataset.sourceStart !== undefined ? block.dataset.sourceStart : 0.0;
                            hostEl.dataset.trackIndex = block.dataset.trackIndex;
                            hostEl.style.zIndex = 100 - parseInt(block.dataset.trackIndex || 0);
                            
                            // Synchronize compressor settings to keep preview frame in sync
                            if (block.dataset.compressTop !== undefined) {
                                hostEl.dataset.compressTop = block.dataset.compressTop;
                            }
                            if (block.dataset.compressBottom !== undefined) {
                                hostEl.dataset.compressBottom = block.dataset.compressBottom;
                            }
                            // Synchronize volume points curve
                            if (block.dataset.volumePoints !== undefined) {
                                hostEl.dataset.volumePoints = block.dataset.volumePoints;
                            }
                        }
                    });

                    // Remove elements that are no longer on the timeline
                    if (hostWindow.trackElements) {
                        for (let i = hostWindow.trackElements.length - 1; i >= 0; i--) {
                            const el = hostWindow.trackElements[i];
                            const elId = el.dataset.id;
                            if (!blockIds.has(elId)) {
                                if (typeof hostWindow.cleanupElementAudio === 'function') {
                                    hostWindow.cleanupElementAudio(el);
                                }
                                el.remove();
                                hostWindow.trackElements.splice(i, 1);
                            }
                        }
                    }
                } catch(e) {
                    needsFullReload = true;
                }
            } else {
                needsFullReload = true;
            }
        }

        if (needsFullReload && !skipReload) {
            debouncedUpdatePreviewSource();
        } else if (!skipReload) {
            if (previewIframe && previewIframe.contentWindow && typeof previewIframe.contentWindow.seekTo === 'function') {
                previewIframe.contentWindow.seekTo(playheadTime, true);
            }
        }

        try {
            localStorage.setItem(`htmlvr_unsaved_project_${currentProject}`, JSON.stringify(project));
        } catch(e) {}

        // Push state to server asynchronously
        fetch(`/api/project/state?project=${encodeURIComponent(currentProject)}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(project)
        }).then(() => {
            lastFetchedStateStr = JSON.stringify({
                tracks: project.tracks || [],
                markers: project.markers || [],
                trackConfigs: project.trackConfigs || []
            });
        }).catch(err => console.error("Error saving state to server:", err));

        pushUndoState();
        redrawAllAudioWaveforms();
    }

    let redrawWaveformsTimeout = null;
    // Re-render blocks and playhead according to new zoom value
    function updateTimelineZoom() {
        const width = MAX_DURATION * PX_PER_SECOND + TIMELINE_OFFSET;
        timelineRuler.style.width = `${width}px`;
        const rows = document.querySelectorAll('.track-row');
        rows.forEach(row => row.style.width = `${width}px`);
        
        initRuler();
        
        const blocks = document.querySelectorAll('.timeline-block');
        blocks.forEach(block => {
            const start = parseFloat(block.dataset.start);
            const duration = parseFloat(block.dataset.duration);
            block.style.left = `${TIMELINE_OFFSET + start * PX_PER_SECOND}px`;
            block.style.width = `${duration * PX_PER_SECOND}px`;
        });
        
        setPlayheadVisual(playheadTime);
        
        // Debounce waveform redraws to prevent main-thread layout thrashing & audio stutter
        if (redrawWaveformsTimeout) clearTimeout(redrawWaveformsTimeout);
        redrawWaveformsTimeout = setTimeout(() => {
            redrawAllAudioWaveforms();
        }, 100);
    }

    // Rebuild the HTML track row blocks from project state
    function rebuildTimelineFromProject(skipIframeReload = false) {
        const blocks = document.querySelectorAll('.timeline-block');
        blocks.forEach(b => b.remove());
        
        project.tracks.forEach(track => {
            const block = createTimelineBlock(
                track.src,
                track.name,
                track.start,
                track.duration,
                track.trackIndex,
                track.fadeIn || 0,
                track.fadeOut || 0,
                track.compressTop !== undefined ? track.compressTop : 1.0,
                track.compressBottom !== undefined ? track.compressBottom : 0.0,
                track.panX || 0,
                track.panY || 0,
                track.scale || 1.0,
                track.rotation || 0,
                track.opacity !== undefined ? track.opacity : 1.0,
                track.volumePoints,
                track.sourceStart !== undefined ? track.sourceStart : 0.0
            );
            if (track.scaleX !== undefined) block.dataset.scaleX = track.scaleX;
            if (track.scaleY !== undefined) block.dataset.scaleY = track.scaleY;
            if (track.opacity !== undefined) block.dataset.opacity = track.opacity;
            if (track.transitionIn !== undefined) block.dataset.transitionIn = track.transitionIn;
            if (track.transitionOut !== undefined) block.dataset.transitionOut = track.transitionOut;
            if (track.subprojDefaultTransition !== undefined) block.dataset.subprojDefaultTransition = track.subprojDefaultTransition;
            if (track.subprojTransitionDuration !== undefined) block.dataset.subprojTransitionDuration = track.subprojTransitionDuration;
            if (track.subprojTransitionOverride !== undefined) block.dataset.subprojTransitionOverride = track.subprojTransitionOverride;
            if (track.mirror !== undefined) block.dataset.mirror = track.mirror ? "true" : "false";
            if (track.animate_tool !== undefined) {
                block.dataset.animateTool = JSON.stringify(track.animate_tool);
            }
            if (track.sourceStart !== undefined) {
                block.dataset.sourceStart = track.sourceStart;
            }
            if (track.id) {
                block.dataset.id = track.id;
            }
        });
        
        recalculateTimelineDuration();
        if (!skipIframeReload) {
            updatePreviewSource();
        } else {
            // Update in-memory state in the iframe and sync DOM properties
            if (previewIframe && previewIframe.contentWindow) {
                try {
                    const hostWindow = previewIframe.contentWindow;
                    if (hostWindow.project) {
                        hostWindow.project.tracks = JSON.parse(JSON.stringify(project.tracks));
                    }
                    if (typeof hostWindow.seekTo === 'function') {
                        hostWindow.seekTo(playheadTime, true);
                    }
                } catch (e) {}
            }
        }
        renderMarkers();
        syncActiveClipToIframe();
    }

    function redrawAllAudioWaveforms() {
        document.querySelectorAll('.timeline-block').forEach(block => {
            const src = block.dataset.src;
            const isAudio = src.toLowerCase().endsWith('.mp3') || src.toLowerCase().endsWith('.wav') || src.toLowerCase().endsWith('.ogg') || src.startsWith('project:');
            if (isAudio && !src.startsWith('project:')) {
                const canvas = block.querySelector('.wave-canvas');
                if (canvas) {
                    const duration = parseFloat(block.dataset.duration);
                    const sourceStart = parseFloat(block.dataset.sourceStart || 0.0);
                    const blockWidth = duration * PX_PER_SECOND;
                    window.AudioVisualizer.drawWaveform(canvas, src, 'rgba(59, 130, 246, 0.6)', blockWidth, 44, sourceStart, duration);
                }
            }
        });
    }

    function insertTrackAt(index) {
        project.trackConfigs.splice(index, 0, { name: `Track ${project.trackConfigs.length + 1}` });
        project.tracks.forEach(clip => {
            if (clip.trackIndex >= index) {
                clip.trackIndex += 1;
            }
        });
        project.trackConfigs.forEach((t, i) => {
            t.name = `Track ${i + 1}`;
        });
        rebuildTracksUI();
        updateProjectFromTimeline();
    }

    function deleteTrackAt(index, skipReload = false) {
        project.trackConfigs.splice(index, 1);
        project.tracks = project.tracks.filter(clip => parseInt(clip.trackIndex) !== index);
        project.tracks.forEach(clip => {
            const trIdx = parseInt(clip.trackIndex);
            if (trIdx > index) {
                clip.trackIndex = trIdx - 1;
            }
        });
        project.trackConfigs.forEach((t, i) => {
            t.name = `Track ${i + 1}`;
        });
        if (!skipReload) {
            rebuildTracksUI();
            updateProjectFromTimeline();
        }
    }

    function propagateTrackVolumesToPreview() {
        if (previewIframe && previewIframe.contentWindow) {
            try {
                if (typeof previewIframe.contentWindow.updateTrackVolumes === 'function') {
                    const volumes = project.trackConfigs.map(t => t.volume !== undefined ? t.volume : 1.0);
                    previewIframe.contentWindow.updateTrackVolumes(volumes);
                }
            } catch (err) {
                console.warn("Failed to propagate track volumes:", err);
            }
        }
    }

    function propagateTrackSelectionToPreview() {
        if (previewIframe && previewIframe.contentWindow) {
            try {
                if (typeof previewIframe.contentWindow.setSelectedTracksForVU === 'function') {
                    const selectedIndices = Array.from(document.querySelectorAll('.track-header.selected'))
                        .map(h => parseInt(h.dataset.trackIndex));
                    previewIframe.contentWindow.setSelectedTracksForVU(selectedIndices);
                }
            } catch (err) {}
        }
    }

    function rebuildTracksUI() {
        const headerCol = document.querySelector('.track-header-col');
        if (!headerCol) return;
        headerCol.innerHTML = '';

        // Add 30px spacer to align track headers with the timeline ruler on the right
        const spacer = document.createElement('div');
        spacer.className = 'track-header-spacer';
        spacer.style.height = '30px';
        spacer.style.borderBottom = '1px solid rgba(255, 255, 255, 0.05)';
        spacer.style.boxSizing = 'border-box';
        headerCol.appendChild(spacer);

        const headersList = document.createElement('div');
        headersList.className = 'track-headers-list';
        headerCol.appendChild(headersList);

        const existingRows = tracksContainer.querySelectorAll('.track-row');
        existingRows.forEach(row => row.remove());

        // Gather currently selected track indexes to restore after rebuild
        const selectedIndices = Array.from(document.querySelectorAll('.track-header.selected'))
            .map(h => parseInt(h.dataset.trackIndex));

        project.trackConfigs.forEach((track, i) => {
            const header = document.createElement('div');
            header.className = 'track-header' + (track.muted ? ' muted' : '');
            if (selectedIndices.includes(i)) {
                header.classList.add('selected');
            }
            header.dataset.trackIndex = i;
            
            const titleSpan = document.createElement('span');
            titleSpan.innerText = track.name || `Track ${i + 1}`;
            header.appendChild(titleSpan);

            const iconContainer = document.createElement('div');
            iconContainer.className = 'track-header-icons';

            // Volume Controller
            const volContainer = document.createElement('div');
            volContainer.className = 'track-volume-control';
            volContainer.title = 'Drag vertically to adjust volume';
            
            const volLabel = document.createElement('span');
            volLabel.className = 'track-volume-label';
            volLabel.innerText = 'V:';
            volContainer.appendChild(volLabel);
            
            const volVal = document.createElement('span');
            volVal.className = 'track-volume-value';
            const trackVol = track.volume !== undefined ? track.volume : 1.0;
            volVal.innerText = trackVol.toFixed(2);
            volContainer.appendChild(volVal);
            
            volVal.addEventListener('mousedown', (e) => {
                e.preventDefault();
                e.stopPropagation();
                
                const startY = e.clientY;
                const startVol = track.volume !== undefined ? track.volume : 1.0;
                
                const onMouseMove = (ev) => {
                    const diffY = startY - ev.clientY;
                    const delta = diffY / 150;
                    let newVol = Math.max(0.0, Math.min(2.0, startVol + delta));
                    newVol = parseFloat(newVol.toFixed(2));
                    
                    const selectedHeaders = document.querySelectorAll('.track-header.selected');
                    const selectedIdxs = Array.from(selectedHeaders).map(h => parseInt(h.dataset.trackIndex));
                    
                    if (selectedIdxs.includes(i)) {
                        selectedIdxs.forEach(idx => {
                            if (project.trackConfigs[idx]) {
                                project.trackConfigs[idx].volume = newVol;
                                const valSpan = document.querySelector(`.track-header[data-track-index="${idx}"] .track-volume-value`);
                                if (valSpan) valSpan.innerText = newVol.toFixed(2);
                            }
                        });
                    } else {
                        track.volume = newVol;
                        volVal.innerText = newVol.toFixed(2);
                    }
                    
                    propagateTrackVolumesToPreview();
                };
                
                const onMouseUp = () => {
                    document.removeEventListener('mousemove', onMouseMove);
                    document.removeEventListener('mouseup', onMouseUp);
                    pushUndoState();
                    updateProjectFromTimeline(true);
                };
                
                document.addEventListener('mousemove', onMouseMove);
                document.addEventListener('mouseup', onMouseUp);
            });

            volVal.addEventListener('dblclick', (e) => {
                e.stopPropagation();
                pushUndoState();
                
                const selectedHeaders = document.querySelectorAll('.track-header.selected');
                const selectedIdxs = Array.from(selectedHeaders).map(h => parseInt(h.dataset.trackIndex));
                
                if (selectedIdxs.includes(i)) {
                    selectedIdxs.forEach(idx => {
                        if (project.trackConfigs[idx]) {
                            project.trackConfigs[idx].volume = 1.0;
                            const valSpan = document.querySelector(`.track-header[data-track-index="${idx}"] .track-volume-value`);
                            if (valSpan) valSpan.innerText = '1.00';
                        }
                    });
                } else {
                    track.volume = 1.0;
                    volVal.innerText = '1.00';
                }
                
                propagateTrackVolumesToPreview();
                updateProjectFromTimeline(true);
            });
            
            iconContainer.appendChild(volContainer);

            // Mute Button
            const muteBtn = document.createElement('span');
            muteBtn.className = 'track-header-mute' + (track.muted ? ' active' : '');
            muteBtn.innerHTML = 'M';
            muteBtn.title = track.muted ? 'Unmute track' : 'Mute track';
            muteBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                track.muted = !track.muted;
                
                header.classList.toggle('muted', track.muted);
                muteBtn.classList.toggle('active', track.muted);
                muteBtn.title = track.muted ? 'Unmute track' : 'Mute track';
                
                const row = document.querySelector(`.track-row[data-track-index="${i}"]`);
                if (row) {
                    row.classList.toggle('muted', track.muted);
                }

                if (previewIframe && previewIframe.contentWindow) {
                    try {
                        if (typeof previewIframe.contentWindow.updateTrackMuteState === 'function') {
                            previewIframe.contentWindow.updateTrackMuteState(i, track.muted);
                        }
                    } catch (err) {
                        console.warn("Failed to propagate mute state to preview iframe:", err);
                    }
                }
                updateProjectFromTimeline(true);
                if (!isPlaying) {
                    syncIframeSeek(playheadTime, true);
                }
            });
            iconContainer.appendChild(muteBtn);

            // Normalize Button
            const normBtn = document.createElement('span');
            normBtn.className = 'track-header-normalize';
            normBtn.innerText = 'RMS';
            normBtn.title = 'Auto-normalize all audio clips on this track to -18 dB RMS';
            normBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                normalizeTrackClips(i);
            });
            iconContainer.appendChild(normBtn);

            header.appendChild(iconContainer);

            // Selection toggle logic on click on the header block
            header.addEventListener('click', (e) => {
                if (e.target.closest('.track-header-normalize') || 
                    e.target.closest('.track-header-mute') || 
                    e.target.closest('.track-volume-control') || 
                    e.target.closest('.track-header-border-insert')) {
                    return;
                }
                
                const trackIdx = i;
                if (e.ctrlKey || e.metaKey) {
                    header.classList.toggle('selected');
                } else if (e.shiftKey) {
                    const selected = document.querySelectorAll('.track-header.selected');
                    if (selected.length > 0) {
                        const firstIdx = parseInt(selected[0].dataset.trackIndex);
                        const start = Math.min(firstIdx, trackIdx);
                        const end = Math.max(firstIdx, trackIdx);
                        document.querySelectorAll('.track-header').forEach(h => {
                            const idx = parseInt(h.dataset.trackIndex);
                            if (idx >= start && idx <= end) {
                                h.classList.add('selected');
                            } else {
                                h.classList.remove('selected');
                            }
                        });
                    } else {
                        header.classList.add('selected');
                    }
                } else {
                    const wasSelected = header.classList.contains('selected');
                    document.querySelectorAll('.track-header').forEach(h => h.classList.remove('selected'));
                    if (!wasSelected) {
                        header.classList.add('selected');
                    }
                }
                propagateTrackSelectionToPreview();
                if (typeof updateMasterCompressorVisuals === 'function') {
                    updateMasterCompressorVisuals();
                }
            });

            // Boundary Pluses / Insert Zones
            if (i === 0) {
                const topInsert = document.createElement('div');
                topInsert.className = 'track-header-border-insert top-insert';
                topInsert.title = 'Insert Track Above';
                topInsert.addEventListener('click', (e) => {
                    e.stopPropagation();
                    insertTrackAt(0);
                });
                header.appendChild(topInsert);
            }

            const bottomInsert = document.createElement('div');
            bottomInsert.className = 'track-header-border-insert bottom-insert';
            bottomInsert.title = 'Insert Track Below';
            bottomInsert.addEventListener('click', (e) => {
                e.stopPropagation();
                insertTrackAt(i + 1);
            });
            header.appendChild(bottomInsert);

            headersList.appendChild(header);

            const row = document.createElement('div');
            row.className = 'track-row' + (track.muted ? ' muted' : '');
            row.dataset.trackIndex = i;
            row.style.width = `${MAX_DURATION * PX_PER_SECOND}px`;

            row.addEventListener('dragover', (e) => {
                e.preventDefault();
                row.classList.add('drag-over');
            });

            row.addEventListener('dragleave', () => {
                row.classList.remove('drag-over');
            });

            row.addEventListener('drop', (e) => {
                e.preventDefault();
                row.classList.remove('drag-over');

                try {
                    const data = JSON.parse(e.dataTransfer.getData('text/plain'));
                    const rect = row.getBoundingClientRect();
                    const dropX = e.clientX - rect.left - TIMELINE_OFFSET;
                    let dropTime = dropX / PX_PER_SECOND;
                    
                    dropTime = Math.max(0, dropTime);

                    createTimelineBlock(data.src, data.name, dropTime, 10, i);
                    updateProjectFromTimeline();
                } catch(err) {
                    console.error("Drop processing failure:", err);
                }
            });

            tracksContainer.appendChild(row);
        });

        initRuler();
        rebuildTimelineFromProject(true);
        if (typeof updateMasterCompressorVisuals === 'function') {
            updateMasterCompressorVisuals();
        }
        updatePlayheadVertical();
    }

    function selectClipBlock(block, isMeta = false) {
        if (!block) return;
        if (isMeta) {
            block.classList.toggle('active');
        } else {
            document.querySelectorAll('.timeline-block').forEach(b => b.classList.remove('active'));
            block.classList.add('active');
        }
        syncActiveClipToIframe();
    }

    // Create a new timeline block element
    function createTimelineBlock(src, name, start, duration, trackIndex, fadeIn = 0, fadeOut = 0, compressTop = 1.0, compressBottom = 0.0, panX = 0, panY = 0, scale = 1.0, rotation = 0, opacity = 1.0, volumePoints = null, sourceStart = 0.0) {
        const row = document.querySelector(`.track-row[data-track-index="${trackIndex}"]`);
        
        const block = document.createElement('div');
        block.className = 'timeline-block';
        if (src.startsWith('project:')) {
            block.classList.add('subproject-clip');
        }
        block.dataset.id = `clip_${Date.now()}_${Math.floor(Math.random()*1000)}`;
        block.dataset.src = src;
        block.dataset.name = name;
        block.dataset.start = start;
        block.dataset.duration = duration;
        block.dataset.sourceStart = sourceStart;
        block.dataset.trackIndex = trackIndex;
        block.dataset.fadeIn = fadeIn;
        block.dataset.fadeOut = fadeOut;
        block.dataset.compressTop = compressTop;
        block.dataset.compressBottom = compressBottom;
        block.dataset.panX = panX;
        block.dataset.panY = panY;
        block.dataset.scale = scale;
        block.dataset.scaleX = scale;
        block.dataset.scaleY = scale;
        block.dataset.rotation = rotation;
        block.dataset.opacity = opacity;
        block.dataset.transitionIn = fadeIn > 0 ? 'fade' : 'none';
        block.dataset.transitionOut = fadeOut > 0 ? 'fade' : 'none';
        block.dataset.subprojDefaultTransition = 'none';
        block.dataset.subprojTransitionDuration = '0.5';
        block.dataset.subprojTransitionOverride = 'empty';

        const isAudio = src.toLowerCase().endsWith('.mp3') || src.toLowerCase().endsWith('.wav') || src.toLowerCase().endsWith('.ogg') || src.startsWith('project:');
        if (isAudio) {
            const canvas = document.createElement('canvas');
            canvas.className = 'wave-canvas';
            block.appendChild(canvas);
            
            // Draw real waveform
            const blockWidth = duration * PX_PER_SECOND;
            window.AudioVisualizer.drawWaveform(canvas, src, 'rgba(59, 130, 246, 0.6)', blockWidth, 44, sourceStart, duration);
            
            const middleBand = document.createElement('div');
            middleBand.className = 'compress-band';
            middleBand.title = 'Drag up/down to adjust volume';
            block.appendChild(middleBand);
            
            const handleTop = document.createElement('div');
            handleTop.className = 'compress-handle compress-handle-top';
            handleTop.title = 'Squeeze loud parts (Compressor)';
            block.appendChild(handleTop);
            
            const handleBottom = document.createElement('div');
            handleBottom.className = 'compress-handle compress-handle-bottom';
            handleBottom.title = 'Squeeze quiet parts (Boost)';
            block.appendChild(handleBottom);
            
            function syncCompressorToPreview() {
                if (previewIframe && previewIframe.contentWindow) {
                    try {
                        const hostDoc = previewIframe.contentDocument || previewIframe.contentWindow.document;
                        const hostEl = hostDoc.querySelector(`[data-id="${block.dataset.id}"]`);
                        if (hostEl) {
                            hostEl.dataset.compressTop = block.dataset.compressTop;
                            hostEl.dataset.compressBottom = block.dataset.compressBottom;
                        }
                    } catch (err) {
                        // Ignore cross-origin issues or iframe load states
                    }
                }
            }

            function updateSqueezeVisuals() {
                const cTop = parseFloat(block.dataset.compressTop);
                const cBot = parseFloat(block.dataset.compressBottom);
                
                const topPercent = (1 - cTop) * 80;
                handleTop.style.top = `${topPercent}%`;
                
                const bottomPercent = cBot * 80;
                handleBottom.style.bottom = `${bottomPercent}%`;
                
                // Position and size middleBand between handles
                middleBand.style.top = `${topPercent}%`;
                middleBand.style.height = `${100 - bottomPercent - topPercent}%`;
            }
            
            block.updateSqueezeVisuals = updateSqueezeVisuals;
            updateSqueezeVisuals();
            
            middleBand.addEventListener('mousedown', (e) => {
                e.preventDefault();
                e.stopPropagation();
                selectClipBlock(block, e.ctrlKey || e.metaKey || e.shiftKey);
                const startY = e.clientY;
                const startCTop = parseFloat(block.dataset.compressTop);
                const startCBot = parseFloat(block.dataset.compressBottom);
                const blockHeight = block.clientHeight;
                
                let dragTooltip = document.createElement('div');
                dragTooltip.className = 'drag-tooltip';
                dragTooltip.style.position = 'absolute';
                dragTooltip.style.background = 'rgba(15, 23, 42, 0.95)';
                dragTooltip.style.color = '#00f0ff';
                dragTooltip.style.padding = '4px 8px';
                dragTooltip.style.borderRadius = '4px';
                dragTooltip.style.fontSize = '12px';
                dragTooltip.style.fontWeight = 'bold';
                dragTooltip.style.fontFamily = 'sans-serif';
                dragTooltip.style.pointerEvents = 'none';
                dragTooltip.style.zIndex = '9999';
                dragTooltip.style.border = '1px solid rgba(0, 240, 255, 0.3)';
                dragTooltip.style.boxShadow = '0 4px 12px rgba(0, 0, 0, 0.5), 0 0 8px rgba(0, 240, 255, 0.15)';
                document.body.appendChild(dragTooltip);
                
                function onBandMove(ev) {
                    const diffY = ev.clientY - startY;
                    const diffVal = diffY / blockHeight;
                    const shift = -diffVal;
                    
                    const maxShiftUp = Math.min(1.0 - startCTop, 0.8 - startCBot);
                    const maxShiftDown = Math.min(startCTop - 0.1, startCBot - 0.0);
                    
                    const clampedShift = Math.max(-maxShiftDown, Math.min(maxShiftUp, shift));
                    
                    const newCTop = startCTop + clampedShift;
                    const newCBot = startCBot + clampedShift;
                    block.dataset.compressTop = newCTop;
                    block.dataset.compressBottom = newCBot;
                    updateSqueezeVisuals();
                    syncCompressorToPreview();

                    const gain = newCTop * (1.0 + 4.0 * newCBot);
                    let text = "";
                    if (gain <= 0.0001) {
                        text = "-inf dB";
                    } else {
                        const dBVal = 20 * Math.log10(gain);
                        text = `${dBVal > 0.05 ? '+' : ''}${dBVal.toFixed(1)} dB`;
                    }
                    dragTooltip.innerText = text;
                    dragTooltip.style.left = `${ev.clientX + 15}px`;
                    dragTooltip.style.top = `${ev.clientY - 25}px`;
                }
                
                function onBandUp() {
                    document.removeEventListener('mousemove', onBandMove);
                    document.removeEventListener('mouseup', onBandUp);
                    if (dragTooltip) {
                        dragTooltip.remove();
                    }
                    updateProjectFromTimeline();
                }
                
                document.addEventListener('mousemove', onBandMove);
                document.addEventListener('mouseup', onBandUp);
            });
            
            handleTop.addEventListener('mousedown', (e) => {
                e.preventDefault();
                e.stopPropagation();
                selectClipBlock(block, e.ctrlKey || e.metaKey || e.shiftKey);
                const startY = e.clientY;
                const startCTop = parseFloat(block.dataset.compressTop);
                const blockHeight = block.clientHeight;
                
                let dragTooltip = document.createElement('div');
                dragTooltip.className = 'drag-tooltip';
                dragTooltip.style.position = 'absolute';
                dragTooltip.style.background = 'rgba(15, 23, 42, 0.95)';
                dragTooltip.style.color = '#00f0ff';
                dragTooltip.style.padding = '4px 8px';
                dragTooltip.style.borderRadius = '4px';
                dragTooltip.style.fontSize = '12px';
                dragTooltip.style.fontWeight = 'bold';
                dragTooltip.style.fontFamily = 'sans-serif';
                dragTooltip.style.pointerEvents = 'none';
                dragTooltip.style.zIndex = '9999';
                dragTooltip.style.border = '1px solid rgba(0, 240, 255, 0.3)';
                dragTooltip.style.boxShadow = '0 4px 12px rgba(0, 0, 0, 0.5), 0 0 8px rgba(0, 240, 255, 0.15)';
                document.body.appendChild(dragTooltip);
                
                function onTopMove(ev) {
                    const diffY = ev.clientY - startY;
                    let newCTop = startCTop - (diffY / blockHeight);
                    newCTop = Math.max(0.1, Math.min(1.0, newCTop));
                    block.dataset.compressTop = newCTop;
                    updateSqueezeVisuals();
                    syncCompressorToPreview();

                    const cBot = parseFloat(block.dataset.compressBottom);
                    const gain = newCTop * (1.0 + 4.0 * cBot);
                    let text = "";
                    if (gain <= 0.0001) {
                        text = "-inf dB";
                    } else {
                        const dBVal = 20 * Math.log10(gain);
                        text = `${dBVal > 0.05 ? '+' : ''}${dBVal.toFixed(1)} dB`;
                    }
                    dragTooltip.innerText = text;
                    dragTooltip.style.left = `${ev.clientX + 15}px`;
                    dragTooltip.style.top = `${ev.clientY - 25}px`;
                }
                
                function onTopUp() {
                    document.removeEventListener('mousemove', onTopMove);
                    document.removeEventListener('mouseup', onTopUp);
                    if (dragTooltip) {
                        dragTooltip.remove();
                    }
                    updateProjectFromTimeline();
                }
                
                document.addEventListener('mousemove', onTopMove);
                document.addEventListener('mouseup', onTopUp);
            });
            
            handleBottom.addEventListener('mousedown', (e) => {
                e.preventDefault();
                e.stopPropagation();
                selectClipBlock(block, e.ctrlKey || e.metaKey || e.shiftKey);
                const startY = e.clientY;
                const startCBot = parseFloat(block.dataset.compressBottom);
                const blockHeight = block.clientHeight;
                
                let dragTooltip = document.createElement('div');
                dragTooltip.className = 'drag-tooltip';
                dragTooltip.style.position = 'absolute';
                dragTooltip.style.background = 'rgba(15, 23, 42, 0.95)';
                dragTooltip.style.color = '#00f0ff';
                dragTooltip.style.padding = '4px 8px';
                dragTooltip.style.borderRadius = '4px';
                dragTooltip.style.fontSize = '12px';
                dragTooltip.style.fontWeight = 'bold';
                dragTooltip.style.fontFamily = 'sans-serif';
                dragTooltip.style.pointerEvents = 'none';
                dragTooltip.style.zIndex = '9999';
                dragTooltip.style.border = '1px solid rgba(0, 240, 255, 0.3)';
                dragTooltip.style.boxShadow = '0 4px 12px rgba(0, 0, 0, 0.5), 0 0 8px rgba(0, 240, 255, 0.15)';
                document.body.appendChild(dragTooltip);
                
                function onBottomMove(ev) {
                    const diffY = ev.clientY - startY;
                    let newCBot = startCBot - (diffY / blockHeight);
                    newCBot = Math.max(0.0, Math.min(0.8, newCBot));
                    block.dataset.compressBottom = newCBot;
                    updateSqueezeVisuals();
                    syncCompressorToPreview();

                    const cTop = parseFloat(block.dataset.compressTop);
                    const gain = cTop * (1.0 + 4.0 * newCBot);
                    let text = "";
                    if (gain <= 0.0001) {
                        text = "-inf dB";
                    } else {
                        const dBVal = 20 * Math.log10(gain);
                        text = `${dBVal > 0.05 ? '+' : ''}${dBVal.toFixed(1)} dB`;
                    }
                    dragTooltip.innerText = text;
                    dragTooltip.style.left = `${ev.clientX + 15}px`;
                    dragTooltip.style.top = `${ev.clientY - 25}px`;
                }
                
                function onBottomUp() {
                    document.removeEventListener('mousemove', onBottomMove);
                    document.removeEventListener('mouseup', onBottomUp);
                    if (dragTooltip) {
                        dragTooltip.remove();
                    }
                    updateProjectFromTimeline();
                }
                
                document.addEventListener('mousemove', onBottomMove);
                document.addEventListener('mouseup', onBottomUp);
            });
            
            // Invoke sync on initial block creation to make sure preview state is aligned
            syncCompressorToPreview();

            // --- VOLUME AUTOMATION ENVELOPE IMPLEMENTATION ---
            let points = [];
            if (volumePoints) {
                points = typeof volumePoints === 'string' ? JSON.parse(volumePoints) : volumePoints;
            } else if (block.dataset.volumePoints) {
                try {
                    points = JSON.parse(block.dataset.volumePoints);
                } catch(e) {
                    points = [];
                }
            }
            if (points.length === 0) {
                points = [
                    { t: sourceStart, v: 1.0 },
                    { t: sourceStart + duration, v: 1.0 }
                ];
            }
            block.dataset.volumePoints = JSON.stringify(points);

            const svgEnvelope = document.createElementNS("http://www.w3.org/2000/svg", "svg");
            svgEnvelope.setAttribute("class", "volume-envelope-svg");
            svgEnvelope.style.zIndex = "4";
            svgEnvelope.setAttribute("viewBox", "0 0 100 100");
            svgEnvelope.setAttribute("preserveAspectRatio", "none");
            block.appendChild(svgEnvelope);

            const pathEnvelope = document.createElementNS("http://www.w3.org/2000/svg", "path");
            pathEnvelope.setAttribute("class", "volume-envelope-path");
            svgEnvelope.appendChild(pathEnvelope);

            const pointsContainer = document.createElement("div");
            pointsContainer.className = "volume-points-container";
            block.appendChild(pointsContainer);

            function syncVolumePointsToPreview() {
                if (previewIframe && previewIframe.contentWindow) {
                    try {
                        const hostDoc = previewIframe.contentDocument || previewIframe.contentWindow.document;
                        const hostEl = hostDoc.querySelector(`[data-id="${block.dataset.id}"]`);
                        if (hostEl) {
                            hostEl.dataset.volumePoints = block.dataset.volumePoints;
                        }
                    } catch (err) {}
                }
            }

            function getLinearPath(pts) {
                if (pts.length === 0) return "";
                let path = `M ${pts[0].x} ${pts[0].y}`;
                for (let i = 1; i < pts.length; i++) {
                    path += ` L ${pts[i].x} ${pts[i].y}`;
                }
                return path;
            }

            function getLocalEnvelopeVolume(pts, t) {
                if (!pts || pts.length === 0) return 1.0;
                const sorted = [...pts].sort((a, b) => a.t - b.t);
                if (t <= sorted[0].t) return sorted[0].v;
                if (t >= sorted[sorted.length - 1].t) return sorted[sorted.length - 1].v;
                
                let idx = 0;
                for (let i = 0; i < sorted.length - 1; i++) {
                    if (t >= sorted[i].t && t <= sorted[i + 1].t) {
                        idx = i;
                        break;
                    }
                }
                const p1 = sorted[idx];
                const p2 = sorted[idx + 1];
                const dt = p2.t - p1.t;
                if (dt === 0) return p1.v;
                const u = (t - p1.t) / dt;
                
                const v = p1.v + u * (p2.v - p1.v);
                return Math.max(0.0, Math.min(1.0, v));
            }

            function updateEnvelopeVisuals() {
                pointsContainer.innerHTML = "";
                const dur = parseFloat(block.dataset.duration) || 1.0;
                const srcStart = parseFloat(block.dataset.sourceStart || 0.0);
                
                const vLeft = getLocalEnvelopeVolume(points, srcStart);
                const vRight = getLocalEnvelopeVolume(points, srcStart + dur);
                
                const pathPoints = [];
                pathPoints.push({ t: srcStart, v: vLeft });
                
                points.forEach(p => {
                    if (p.t > srcStart && p.t < srcStart + dur) {
                        pathPoints.push(p);
                    }
                });
                
                pathPoints.push({ t: srcStart + dur, v: vRight });
                pathPoints.sort((a, b) => a.t - b.t);
                
                const svgPoints = pathPoints.map(p => {
                    const x = ((p.t - srcStart) / dur) * 100;
                    const y = 98 - p.v * 96;
                    return { x, y };
                });
                
                pathEnvelope.setAttribute("d", getLinearPath(svgPoints));
                pathEnvelope.setAttribute("fill", "none");
                pathEnvelope.setAttribute("stroke", "rgba(56, 189, 248, 0.75)");
                pathEnvelope.setAttribute("stroke-width", "1.2");
                pathEnvelope.setAttribute("vector-effect", "non-scaling-stroke");
                pathEnvelope.style.pointerEvents = "stroke";
                pathEnvelope.style.cursor = "ns-resize";
                
                points.forEach((p, idx) => {
                    if (p.t >= srcStart - 0.001 && p.t <= srcStart + dur + 0.001) {
                        const xPercent = ((p.t - srcStart) / dur) * 100;
                        const yPercent = 98 - p.v * 96;
                        
                        const dot = document.createElement("div");
                        dot.className = "volume-point-dot";
                        dot.style.left = `${xPercent}%`;
                        dot.style.top = `${yPercent}%`;
                        dot.title = `Volume: ${Math.round(p.v * 100)}%`;
                        
                        dot.addEventListener('dblclick', (ev) => {
                            ev.preventDefault();
                            ev.stopPropagation();
                            if (points.length <= 1) return;
                            points.splice(idx, 1);
                            block.dataset.volumePoints = JSON.stringify(points);
                            updateEnvelopeVisuals();
                            syncVolumePointsToPreview();
                            updateProjectFromTimeline();
                        });
                        
                        dot.addEventListener('mousedown', (ev) => {
                            ev.preventDefault();
                            ev.stopPropagation();
                            selectClipBlock(block, ev.ctrlKey || ev.metaKey || ev.shiftKey);
                            
                            const durVal = parseFloat(block.dataset.duration) || 1.0;
                            const srcStartVal = parseFloat(block.dataset.sourceStart || 0.0);
                            const startMouseX = ev.clientX;
                            const startMouseY = ev.clientY;
                            const startT = p.t;
                            const startV = p.v;
                            const w = block.clientWidth || 100;
                            const h = block.clientHeight || 50;

                            let activeIdx = idx;
                            if (activeIdx === 0 && Math.abs(startT - srcStartVal) < 0.01) {
                                const hasNeighbor = points.some((pt, i) => i > 0 && pt.t > srcStartVal + 0.01 && pt.t <= srcStartVal + 2.0);
                                if (!hasNeighbor) {
                                    const fadeTime = Math.min(1.0, durVal / 2);
                                    points.push({ t: srcStartVal + fadeTime, v: 1.0 });
                                    points.sort((a, b) => a.t - b.t);
                                    block.dataset.volumePoints = JSON.stringify(points);
                                    updateEnvelopeVisuals();
                                    activeIdx = points.indexOf(p);
                                }
                            }
                            
                            if (activeIdx === points.length - 1 && Math.abs(startT - (srcStartVal + durVal)) < 0.01) {
                                const hasNeighbor = points.some((pt, i) => i < points.length - 1 && pt.t >= srcStartVal + durVal - 2.0 && pt.t < srcStartVal + durVal - 0.01);
                                if (!hasNeighbor) {
                                    const fadeTime = Math.max(srcStartVal, srcStartVal + durVal - 1.0);
                                    points.push({ t: fadeTime, v: 1.0 });
                                    points.sort((a, b) => a.t - b.t);
                                    block.dataset.volumePoints = JSON.stringify(points);
                                    updateEnvelopeVisuals();
                                    activeIdx = points.indexOf(p);
                                }
                            }
                            
                            let dragTooltip = document.createElement('div');
                            dragTooltip.className = 'drag-tooltip';
                            dragTooltip.style.position = 'absolute';
                            dragTooltip.style.background = 'rgba(15, 23, 42, 0.95)';
                            dragTooltip.style.color = '#d946ef';
                            dragTooltip.style.padding = '4px 8px';
                            dragTooltip.style.borderRadius = '4px';
                            dragTooltip.style.fontSize = '12px';
                            dragTooltip.style.fontWeight = 'bold';
                            dragTooltip.style.fontFamily = 'sans-serif';
                            dragTooltip.style.pointerEvents = 'none';
                            dragTooltip.style.zIndex = '9999';
                            dragTooltip.style.border = '1px solid rgba(217, 70, 239, 0.3)';
                            dragTooltip.style.boxShadow = '0 4px 12px rgba(0, 0, 0, 0.5), 0 0 8px rgba(217, 70, 239, 0.15)';
                            document.body.appendChild(dragTooltip);
                            
                            const startDB = startV > 0.0001 ? 20 * Math.log10(startV) : -Infinity;
                            dragTooltip.innerText = `${Math.round(startV * 100)}% (${startDB > -Infinity ? (startDB > 0.05 ? '+' : '') + startDB.toFixed(1) + ' dB' : '-inf dB'})`;
                            dragTooltip.style.left = `${ev.clientX + 15}px`;
                            dragTooltip.style.top = `${ev.clientY - 25}px`;

                            function onPointMove(moveEv) {
                                const diffX = moveEv.clientX - startMouseX;
                                const diffY = moveEv.clientY - startMouseY;
                                
                                const deltaT = (diffX / w) * durVal;
                                const deltaV = -(diffY / h) * 1.25;
                                
                                let newT = Math.max(srcStartVal, Math.min(srcStartVal + durVal, startT + deltaT));
                                let newV = Math.max(0.0, Math.min(1.0, startV + deltaV));
                                
                                const leftLimit = activeIdx > 0 ? points[activeIdx - 1].t : srcStartVal;
                                const rightLimit = activeIdx < points.length - 1 ? points[activeIdx + 1].t : srcStartVal + durVal;
                                newT = Math.max(leftLimit, Math.min(rightLimit, newT));
                                
                                p.t = newT;
                                p.v = newV;
                                
                                block.dataset.volumePoints = JSON.stringify(points);
                                updateEnvelopeVisuals();
                                syncVolumePointsToPreview();

                                const curDB = newV > 0.0001 ? 20 * Math.log10(newV) : -Infinity;
                                dragTooltip.innerText = `${Math.round(newV * 100)}% (${curDB > -Infinity ? (curDB > 0.05 ? '+' : '') + curDB.toFixed(1) + ' dB' : '-inf dB'})`;
                                dragTooltip.style.left = `${moveEv.clientX + 15}px`;
                                dragTooltip.style.top = `${moveEv.clientY - 25}px`;
                            }
                            
                            function onPointUp() {
                                document.removeEventListener('mousemove', onPointMove);
                                document.removeEventListener('mouseup', onPointUp);
                                if (dragTooltip) dragTooltip.remove();
                                updateProjectFromTimeline();
                            }
                            
                            document.addEventListener('mousemove', onPointMove);
                            document.addEventListener('mouseup', onPointUp);
                        });
                        
                        pointsContainer.appendChild(dot);
                    }
                });
            }

            block.updateEnvelopeVisuals = updateEnvelopeVisuals;

            block.addEventListener('dblclick', (ev) => {
                if (ev.target.classList.contains('volume-point-dot') || ev.target.classList.contains('compress-handle')) return;
                ev.preventDefault();
                ev.stopPropagation();
                
                const rect = block.getBoundingClientRect();
                const offsetX = ev.clientX - rect.left;
                const offsetY = ev.clientY - rect.top;
                
                const dur = parseFloat(block.dataset.duration) || 1.0;
                const srcStart = parseFloat(block.dataset.sourceStart || 0.0);
                const newT = srcStart + Math.max(0, Math.min(dur, (offsetX / rect.width) * dur));
                const yPercent = (offsetY / rect.height) * 100;
                const newV = Math.max(0.0, Math.min(1.0, (98 - yPercent) / 96));
                
                points.push({ t: newT, v: newV });
                points.sort((a, b) => a.t - b.t);
                
                block.dataset.volumePoints = JSON.stringify(points);
                updateEnvelopeVisuals();
                syncVolumePointsToPreview();
                updateProjectFromTimeline();
            });

            pathEnvelope.addEventListener('mousedown', (e) => {
                e.preventDefault();
                e.stopPropagation();
                selectClipBlock(block, e.ctrlKey || e.metaKey || e.shiftKey);

                const startY = e.clientY;
                const blockHeight = block.clientHeight || 50;
                const initialPoints = JSON.parse(JSON.stringify(points));

                let dragTooltip = document.createElement('div');
                dragTooltip.className = 'drag-tooltip';
                dragTooltip.style.position = 'absolute';
                dragTooltip.style.background = 'rgba(15, 23, 42, 0.95)';
                dragTooltip.style.color = '#38bdf8';
                dragTooltip.style.padding = '4px 8px';
                dragTooltip.style.borderRadius = '4px';
                dragTooltip.style.fontSize = '12px';
                dragTooltip.style.fontWeight = 'bold';
                dragTooltip.style.fontFamily = 'sans-serif';
                dragTooltip.style.pointerEvents = 'none';
                dragTooltip.style.zIndex = '9999';
                dragTooltip.style.border = '1px solid rgba(56, 189, 248, 0.3)';
                dragTooltip.style.boxShadow = '0 4px 12px rgba(0, 0, 0, 0.5)';
                document.body.appendChild(dragTooltip);

                function onLineMove(ev) {
                    const diffY = ev.clientY - startY;
                    const deltaV = -(diffY / blockHeight);

                    points.forEach((p, idx) => {
                        const baseV = initialPoints[idx] !== undefined ? initialPoints[idx].v : p.v;
                        p.v = Math.max(0.0, Math.min(1.0, baseV + deltaV));
                    });

                    block.dataset.volumePoints = JSON.stringify(points);
                    updateEnvelopeVisuals();
                    syncVolumePointsToPreview();

                    const avgV = points.reduce((sum, p) => sum + p.v, 0) / (points.length || 1);
                    const curDB = avgV > 0.0001 ? 20 * Math.log10(avgV) : -Infinity;
                    const text = `Volume: ${Math.round(avgV * 100)}% (${curDB > -Infinity ? (curDB > 0.05 ? '+' : '') + curDB.toFixed(1) + ' dB' : '-inf dB'})`;
                    dragTooltip.innerText = text;
                    dragTooltip.style.left = `${ev.clientX + 15}px`;
                    dragTooltip.style.top = `${ev.clientY - 25}px`;
                }

                function onLineUp() {
                    document.removeEventListener('mousemove', onLineMove);
                    document.removeEventListener('mouseup', onLineUp);
                    if (dragTooltip) dragTooltip.remove();
                    updateProjectFromTimeline();
                }

                document.addEventListener('mousemove', onLineMove);
                document.addEventListener('mouseup', onLineUp);
            });

            updateEnvelopeVisuals();
            syncVolumePointsToPreview();
        }

        const label = document.createElement('span');
        label.className = 'clip-label';
        label.innerText = name;
        label.style.overflow = 'hidden';
        label.style.textOverflow = 'ellipsis';
        label.style.whiteSpace = 'nowrap';
        label.style.flexGrow = '1';
        label.style.position = 'relative';
        label.style.zIndex = '2';
        label.style.pointerEvents = 'none';
        block.appendChild(label);

        if (src.startsWith('project:')) {
            const subProjName = src.substring(8);
            const editBtn = document.createElement('span');
            editBtn.className = 'subproject-edit-link';
            editBtn.innerText = ' [Edit ↗]';
            editBtn.title = `Edit subproject ${subProjName}`;
            editBtn.style.position = 'relative';
            editBtn.style.zIndex = '10';
            editBtn.style.pointerEvents = 'auto';
            editBtn.addEventListener('mousedown', (e) => {
                e.stopPropagation();
            });
            editBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                window.location.search = `?project=${encodeURIComponent(subProjName)}`;
            });
            block.appendChild(editBtn);
        }

        // (Old clip-level delete button removed)

        // Render positions
        block.style.left = `${TIMELINE_OFFSET + start * PX_PER_SECOND}px`;
        block.style.width = `${duration * PX_PER_SECOND}px`;

        // Left Resize handle
        const handleLeft = document.createElement('div');
        handleLeft.className = 'resize-handle resize-handle-left';
        block.appendChild(handleLeft);

        // Right Resize handle
        const handleRight = document.createElement('div');
        handleRight.className = 'resize-handle resize-handle-right';
        block.appendChild(handleRight);

        // Handle Resizing
        let isResizing = false;
        let resizeDir = '';
        let startX = 0;
        let resizeSnapshot = [];

        function onResizeStart(e, dir) {
            e.stopPropagation();
            e.preventDefault();
            isResizing = true;
            resizeDir = dir;
            startX = e.clientX;

            // If the current block is not in the active selection, clear others and select it
            if (!block.classList.contains('active')) {
                document.querySelectorAll('.timeline-block').forEach(b => b.classList.remove('active'));
                block.classList.add('active');
            }

            // Store starting coordinates for all blocks on the timeline
            resizeSnapshot = [];
            document.querySelectorAll('.timeline-block').forEach(el => {
                resizeSnapshot.push({
                    el: el,
                    id: el.dataset.id,
                    start: parseFloat(el.dataset.start) || 0,
                    duration: parseFloat(el.dataset.duration) || 0,
                    sourceStart: parseFloat(el.dataset.sourceStart) || 0,
                    trackIndex: parseInt(el.dataset.trackIndex) || 0,
                    isActive: el.classList.contains('active')
                });
            });

            document.addEventListener('mousemove', onResizeMove);
            document.addEventListener('mouseup', onResizeEnd);
        }

        handleLeft.addEventListener('mousedown', (e) => onResizeStart(e, 'left'));
        handleRight.addEventListener('mousedown', (e) => onResizeStart(e, 'right'));

        function onResizeMove(e) {
            if (!isResizing) return;
            const diffX = e.clientX - startX;
            const diffTime = diffX / PX_PER_SECOND;

            const activeSnaps = resizeSnapshot.filter(s => s.isActive);
            if (activeSnaps.length === 0) return;

            let maxEndNeeded = 0;
            const activeChanges = new Map();

            activeSnaps.forEach(s => {
                if (resizeDir === 'right') {
                    const src = s.el.dataset.src;
                    const isAudio = src.toLowerCase().endsWith('.mp3') || src.toLowerCase().endsWith('.wav') || src.toLowerCase().endsWith('.ogg');
                    let maxDurAllowed = Infinity;
                    if (isAudio) {
                        const cached = window.AudioVisualizer.getCache().get(src);
                        if (cached && cached.duration) {
                            maxDurAllowed = cached.duration - s.sourceStart;
                        }
                    }
                    const newDur = Math.max(0.5, Math.min(maxDurAllowed, s.duration + diffTime));
                    const delta = newDur - s.duration;
                    activeChanges.set(s.id, { newStart: s.start, newDur: newDur, newSourceStart: s.sourceStart, delta: delta });
                } else if (resizeDir === 'left') {
                    const minDelta = Math.max(-s.start, -s.sourceStart);
                    const maxDelta = s.duration - 0.5;
                    const delta = Math.max(minDelta, Math.min(maxDelta, diffTime));
                    
                    const newStart = s.start + delta;
                    const newSourceStart = s.sourceStart + delta;
                    const newDur = s.duration - delta;
                    activeChanges.set(s.id, { newStart: newStart, newDur: newDur, newSourceStart: newSourceStart, delta: delta });
                }
            });

            resizeSnapshot.forEach(s => {
                let finalStart = s.start;
                let finalDur = s.duration;
                let finalSourceStart = s.sourceStart;

                if (s.isActive) {
                    const change = activeChanges.get(s.id);
                    if (change) {
                        finalStart = change.newStart;
                        finalDur = change.newDur;
                        finalSourceStart = change.newSourceStart;
                    }
                } else {
                    if (rippleMode === 'track') {
                        let accumulatedDelta = 0;
                        activeSnaps.forEach(act => {
                            if (act.trackIndex === s.trackIndex) {
                                const change = activeChanges.get(act.id);
                                if (change) {
                                    if (resizeDir === 'right' && s.start >= (act.start + act.duration) - 0.01) {
                                        accumulatedDelta += change.delta;
                                    } else if (resizeDir === 'left' && s.start >= act.start - 0.01) {
                                        accumulatedDelta += change.delta;
                                    }
                                }
                            }
                        });
                        finalStart = s.start + accumulatedDelta;
                    } else if (rippleMode === 'all') {
                        let accumulatedDelta = 0;
                        activeSnaps.forEach(act => {
                            const change = activeChanges.get(act.id);
                            if (change) {
                                if (resizeDir === 'right' && s.start >= (act.start + act.duration) - 0.01) {
                                    accumulatedDelta += change.delta;
                                } else if (resizeDir === 'left' && s.start >= act.start - 0.01) {
                                    accumulatedDelta += change.delta;
                                }
                            }
                        });
                        finalStart = s.start + accumulatedDelta;
                    }
                }

                finalStart = Math.max(0, finalStart);
                s.el.style.left = `${TIMELINE_OFFSET + finalStart * PX_PER_SECOND}px`;
                s.el.style.width = `${finalDur * PX_PER_SECOND}px`;
                s.el.dataset.start = finalStart;
                s.el.dataset.duration = finalDur;
                s.el.dataset.sourceStart = finalSourceStart;

                // Redraw canvas in real-time during resize drag for smooth feedback
                const canvas = s.el.querySelector('.wave-canvas');
                if (canvas) {
                    const blockWidth = finalDur * PX_PER_SECOND;
                    window.AudioVisualizer.drawWaveform(canvas, s.el.dataset.src, 'rgba(59, 130, 246, 0.6)', blockWidth, 44, finalSourceStart, finalDur);
                }

                // Smoothly update volume envelope overlay in real-time
                if (typeof s.el.updateEnvelopeVisuals === 'function') {
                    s.el.updateEnvelopeVisuals();
                }

                const endSec = finalStart + finalDur;
                if (endSec > maxEndNeeded) {
                    maxEndNeeded = endSec;
                }
            });

            adjustTimelineDurationDuringInteraction(maxEndNeeded);
        }

        function onResizeEnd() {
            isResizing = false;
            resizeSnapshot = [];
            document.removeEventListener('mousemove', onResizeMove);
            document.removeEventListener('mouseup', onResizeEnd);
            updateProjectFromTimeline();
        }

        // Handle Dragging
        let isDragging = false;
        let dragStartX = 0;
        let dragStartY = 0;
        let dragSnapshot = [];

        block.addEventListener('mousedown', (e) => {
            if (e.target.classList.contains('resize-handle')) return;
            e.preventDefault();

            selectClipBlock(block, e.ctrlKey || e.metaKey || e.shiftKey);

            if (block.classList.contains('active')) {
                isDragging = true;
                dragStartX = e.clientX;
                dragStartY = e.clientY;

                // Take a snapshot of ALL blocks on the timeline
                dragSnapshot = [];
                document.querySelectorAll('.timeline-block').forEach(el => {
                    dragSnapshot.push({
                        el: el,
                        id: el.dataset.id,
                        start: parseFloat(el.dataset.start) || 0,
                        duration: parseFloat(el.dataset.duration) || 0,
                        trackIndex: parseInt(el.dataset.trackIndex) || 0,
                        isActive: el.classList.contains('active')
                    });
                });

                document.addEventListener('mousemove', onDragMove);
                document.addEventListener('mouseup', onDragEnd);
            }
        });

        function onDragMove(e) {
            if (!isDragging) return;
            const diffX = e.clientX - dragStartX;
            const diffTime = diffX / PX_PER_SECOND;

            const diffY = e.clientY - dragStartY;
            const trackOffset = Math.round(diffY / 60);

            const activeSnaps = dragSnapshot.filter(s => s.isActive);
            if (activeSnaps.length === 0) return;

            const minActiveStart = Math.min(...activeSnaps.map(s => s.start));

            let clampedDiffTime = diffTime;
            if (minActiveStart + clampedDiffTime < 0) {
                clampedDiffTime = -minActiveStart;
            }

            let finalTrackOffset = trackOffset;
            const activeTrackIndices = activeSnaps.map(s => s.trackIndex);
            const minActiveTrack = Math.min(...activeTrackIndices);
            const maxActiveTrack = Math.max(...activeTrackIndices);
            const numTracks = project.trackConfigs.length;

            if (minActiveTrack + finalTrackOffset < 0) {
                finalTrackOffset = -minActiveTrack;
            }
            if (maxActiveTrack + finalTrackOffset >= numTracks) {
                finalTrackOffset = numTracks - 1 - maxActiveTrack;
            }

            let maxEndNeeded = 0;

            dragSnapshot.forEach(s => {
                let newStart = s.start;
                let newTrackIndex = s.trackIndex;

                if (s.isActive) {
                    newStart = s.start + clampedDiffTime;
                    newTrackIndex = s.trackIndex + finalTrackOffset;
                } else {
                    if (rippleMode === 'track') {
                        const sameTrackActive = activeSnaps.some(act => act.trackIndex === s.trackIndex && s.start >= act.start - 0.01);
                        if (sameTrackActive) {
                            newStart = s.start + clampedDiffTime;
                        }
                    } else if (rippleMode === 'all') {
                        if (s.start >= minActiveStart - 0.01) {
                            newStart = s.start + clampedDiffTime;
                        }
                    }
                }

                newStart = Math.max(0, newStart);
                s.el.style.left = `${TIMELINE_OFFSET + newStart * PX_PER_SECOND}px`;
                s.el.dataset.start = newStart;
                s.el.dataset.trackIndex = newTrackIndex;

                const targetRow = document.querySelector(`.track-row[data-track-index="${newTrackIndex}"]`);
                if (targetRow && s.el.parentElement !== targetRow) {
                    targetRow.appendChild(s.el);
                }

                const endSec = newStart + s.duration;
                if (endSec > maxEndNeeded) {
                    maxEndNeeded = endSec;
                }
            });

            adjustTimelineDurationDuringInteraction(maxEndNeeded);
        }

        function onDragEnd() {
            isDragging = false;
            dragSnapshot = [];
            document.removeEventListener('mousemove', onDragMove);
            document.removeEventListener('mouseup', onDragEnd);
            updateProjectFromTimeline();
        }

        // Double click to delete (for non-audio clips, except subprojects)
        if (!src.startsWith('project:')) {
            block.addEventListener('dblclick', () => {
                if (isAudio) return;
                block.remove();
                updateProjectFromTimeline();
            });
        }

        row.appendChild(block);
        return block;
    }

    function splitActiveClipsAtPlayhead() {
        const selected = Array.from(document.querySelectorAll('.timeline-block.active'));
        if (selected.length === 0) return;

        let splitPerformed = false;
        
        // Temporarily clear active classes since we will select the newly created split blocks instead
        selected.forEach(b => b.classList.remove('active'));

        selected.forEach(block => {
            const start = parseFloat(block.dataset.start);
            const duration = parseFloat(block.dataset.duration);
            const end = start + duration;
            const sourceStart = parseFloat(block.dataset.sourceStart || 0);
            
            if (playheadTime > start && playheadTime < end) {
                const src = block.dataset.src;
                const name = block.dataset.name;
                const trackIndex = parseInt(block.dataset.trackIndex);
                const fadeIn = parseFloat(block.dataset.fadeIn) || 0;
                const fadeOut = parseFloat(block.dataset.fadeOut) || 0;
                const compressTop = block.dataset.compressTop !== undefined ? parseFloat(block.dataset.compressTop) : 1.0;
                const compressBottom = block.dataset.compressBottom !== undefined ? parseFloat(block.dataset.compressBottom) : 0.0;
                
                const leftDuration = playheadTime - start;
                const rightDuration = end - playheadTime;
                
                // Remove original block
                block.remove();
                
                // Create left block
                const leftBlock = createTimelineBlock(
                    src,
                    name + " (Part 1)",
                    start,
                    leftDuration,
                    trackIndex,
                    fadeIn,
                    0,
                    compressTop,
                    compressBottom
                );
                if (leftBlock) {
                    leftBlock.dataset.sourceStart = sourceStart;
                }
                
                // Create right block
                const rightBlock = createTimelineBlock(
                    src,
                    name + " (Part 2)",
                    playheadTime,
                    rightDuration,
                    trackIndex,
                    0,
                    fadeOut,
                    compressTop,
                    compressBottom
                );
                if (rightBlock) {
                    rightBlock.dataset.sourceStart = sourceStart + (playheadTime - start);
                }
                
                const copyProperties = (fromBlock, toBlock) => {
                    if (fromBlock.dataset.panX !== undefined) toBlock.dataset.panX = fromBlock.dataset.panX;
                    if (fromBlock.dataset.panY !== undefined) toBlock.dataset.panY = fromBlock.dataset.panY;
                    if (fromBlock.dataset.scale !== undefined) toBlock.dataset.scale = fromBlock.dataset.scale;
                    if (fromBlock.dataset.scaleX !== undefined) toBlock.dataset.scaleX = fromBlock.dataset.scaleX;
                    if (fromBlock.dataset.scaleY !== undefined) toBlock.dataset.scaleY = fromBlock.dataset.scaleY;
                    if (fromBlock.dataset.rotation !== undefined) toBlock.dataset.rotation = fromBlock.dataset.rotation;
                    if (fromBlock.dataset.opacity !== undefined) toBlock.dataset.opacity = fromBlock.dataset.opacity;
                    if (fromBlock.dataset.mirror !== undefined) toBlock.dataset.mirror = fromBlock.dataset.mirror;
                    if (fromBlock.dataset.transitionIn !== undefined) toBlock.dataset.transitionIn = fromBlock.dataset.transitionIn;
                    if (fromBlock.dataset.transitionOut !== undefined) toBlock.dataset.transitionOut = fromBlock.dataset.transitionOut;
                    if (fromBlock.dataset.subprojDefaultTransition !== undefined) toBlock.dataset.subprojDefaultTransition = fromBlock.dataset.subprojDefaultTransition;
                    if (fromBlock.dataset.subprojTransitionDuration !== undefined) toBlock.dataset.subprojTransitionDuration = fromBlock.dataset.subprojTransitionDuration;
                    if (fromBlock.dataset.subprojTransitionOverride !== undefined) toBlock.dataset.subprojTransitionOverride = fromBlock.dataset.subprojTransitionOverride;
                    if (fromBlock.dataset.animateTool !== undefined) toBlock.dataset.animateTool = fromBlock.dataset.animateTool;
                };

                if (leftBlock) {
                    copyProperties(block, leftBlock);
                }
                if (rightBlock) {
                    copyProperties(block, rightBlock);
                }
                
                splitPerformed = true;
            } else {
                // If it wasn't split, restore its active state
                block.classList.add('active');
            }
        });
        
        if (splitPerformed) {
            updateProjectFromTimeline();
        }
    }

    function deleteActiveClips() {
        const selected = Array.from(document.querySelectorAll('.timeline-block.active'));
        if (selected.length === 0) return;
        
        const deletedClips = selected.map(block => {
            return {
                id: block.dataset.id,
                start: parseFloat(block.dataset.start) || 0,
                duration: parseFloat(block.dataset.duration) || 0,
                trackIndex: parseInt(block.dataset.trackIndex) || 0
            };
        });

        selected.forEach(block => {
            block.remove();
        });

        // Ripple Pull Back
        if (rippleMode === 'track') {
            const deletedByTrack = {};
            deletedClips.forEach(c => {
                if (!deletedByTrack[c.trackIndex]) deletedByTrack[c.trackIndex] = [];
                deletedByTrack[c.trackIndex].push(c);
            });

            for (const trackIndex in deletedByTrack) {
                const trackDeletes = deletedByTrack[trackIndex];
                trackDeletes.sort((a, b) => b.start - a.start);

                trackDeletes.forEach(del => {
                    const oldEnd = del.start + del.duration;
                    const trackBlocks = document.querySelectorAll(`.timeline-block[data-track-index="${trackIndex}"]`);
                    trackBlocks.forEach(el => {
                        const start = parseFloat(el.dataset.start) || 0;
                        if (start >= oldEnd - 0.05) {
                            const newStart = Math.max(0, start - del.duration);
                            el.style.left = `${TIMELINE_OFFSET + newStart * PX_PER_SECOND}px`;
                            el.dataset.start = newStart;
                        }
                    });
                });
            }
        } else if (rippleMode === 'all') {
            const minStart = Math.min(...deletedClips.map(c => c.start));
            const maxEnd = Math.max(...deletedClips.map(c => c.start + c.duration));
            const gapDur = maxEnd - minStart;

            if (gapDur > 0) {
                const allBlocks = document.querySelectorAll('.timeline-block');
                allBlocks.forEach(el => {
                    const start = parseFloat(el.dataset.start) || 0;
                    if (start >= maxEnd - 0.05) {
                        const newStart = Math.max(0, start - gapDur);
                        el.style.left = `${TIMELINE_OFFSET + newStart * PX_PER_SECOND}px`;
                        el.dataset.start = newStart;
                    }
                });
            }
        }
        
        syncActiveClipToIframe();
        updateProjectFromTimeline();
    }

    // Setup event listeners
    function initEvents() {
        // Properties panel slider change handler for instant transform updates
        function onPropSliderChange(e) {
            const activeBlock = document.querySelector('.timeline-block.active');
            if (!activeBlock) return;
            
            let scale = parseFloat(propScale.value);
            let scaleX = parseFloat(propScaleX.value);
            let scaleY = parseFloat(propScaleY.value);
            const panX = parseFloat(propPanX.value);
            const panY = parseFloat(propPanY.value);
            const rotation = propRotation ? parseFloat(propRotation.value) : 0;
            const opacity = propOpacity ? parseFloat(propOpacity.value) : 1.0;
            const mirror = propMirror ? propMirror.checked : false;
            
            // If uniform scale was dragged directly, sync X and Y to match
            if (e && e.target === propScale) {
                scaleX = scale;
                scaleY = scale;
                if (propScaleX) propScaleX.value = scale;
                if (propScaleY) propScaleY.value = scale;
            } else {
                if (scaleX === scaleY) {
                    scale = scaleX;
                    propScale.value = scale;
                }
            }
            
            propScaleVal.innerText = scale.toFixed(2);
            if (propScaleXVal) propScaleXVal.innerText = scaleX.toFixed(2);
            if (propScaleYVal) propScaleYVal.innerText = scaleY.toFixed(2);
            propPanXVal.innerText = Math.round(panX);
            propPanYVal.innerText = Math.round(panY);
            if (propRotationVal) propRotationVal.innerText = `${Math.round(rotation)}°`;
            if (propOpacityVal) propOpacityVal.innerText = opacity.toFixed(2);
            
            activeBlock.dataset.scale = scale;
            activeBlock.dataset.scaleX = scaleX;
            activeBlock.dataset.scaleY = scaleY;
            activeBlock.dataset.panX = panX;
            activeBlock.dataset.panY = panY;
            activeBlock.dataset.rotation = rotation;
            activeBlock.dataset.opacity = opacity;
            activeBlock.dataset.mirror = mirror ? "true" : "false";
            
            // Transitions values
            const transInType = propTransInType ? propTransInType.value : 'none';
            const transInDur = propTransInDuration ? parseFloat(propTransInDuration.value) : 0;
            const transOutType = propTransOutType ? propTransOutType.value : 'none';
            const transOutDur = propTransOutDuration ? parseFloat(propTransOutDuration.value) : 0;

            if (propTransInDurationVal) propTransInDurationVal.innerText = `${transInDur.toFixed(2)}s`;
            if (propTransOutDurationVal) propTransOutDurationVal.innerText = `${transOutDur.toFixed(2)}s`;

            activeBlock.dataset.transitionIn = transInType;
            activeBlock.dataset.fadeIn = transInDur;
            activeBlock.dataset.transitionOut = transOutType;
            activeBlock.dataset.fadeOut = transOutDur;

            // Subproject transitions defaults
            const subprojType = propSubprojTransType ? propSubprojTransType.value : 'none';
            const subprojDur = propSubprojTransDuration ? parseFloat(propSubprojTransDuration.value) : 0.5;
            const subprojOverride = propSubprojTransOverride ? propSubprojTransOverride.value : 'empty';

            if (propSubprojTransDurationVal) propSubprojTransDurationVal.innerText = `${subprojDur.toFixed(2)}s`;

            activeBlock.dataset.subprojDefaultTransition = subprojType;
            activeBlock.dataset.subprojTransitionDuration = subprojDur;
            activeBlock.dataset.subprojTransitionOverride = subprojOverride;

            // Animation values
            const animType = propAnimType ? propAnimType.value : 'translate';
            const animEasing = propAnimEasing ? propAnimEasing.value : 'linear';
            const animStart = parseFloat(propAnimStart.value) || 0;
            const animEnd = parseFloat(propAnimEnd.value) || 0;
            const animDir = parseFloat(propAnimDir.value) || 0;
            const animAmp = parseFloat(propAnimAmp.value) || 0;
            const animFreq = parseFloat(propAnimFreq.value) || 1;
            const pivotX = parseFloat(propAnimPivotX.value) || 50;
            const pivotY = parseFloat(propAnimPivotY.value) || 50;

            const propAnimDirRow = document.getElementById('prop-anim-dir-row');
            const propAnimAmpLabel = document.getElementById('prop-anim-amp-label');
            if (animType === 'rotate') {
                if (propAnimDirRow) propAnimDirRow.style.display = 'none';
                if (propAnimAmpLabel) propAnimAmpLabel.innerText = 'Amplitude (Deg)';
                if (propAnimAmp) {
                    propAnimAmp.min = 0;
                    propAnimAmp.max = 1800;
                    propAnimAmp.step = 1;
                }
                if (propAnimAmpVal) propAnimAmpVal.innerText = `${animAmp}°`;
            } else if (animType === 'scale') {
                if (propAnimDirRow) propAnimDirRow.style.display = 'none';
                if (propAnimAmpLabel) propAnimAmpLabel.innerText = 'Amplitude (Scale Change)';
                if (propAnimAmp) {
                    propAnimAmp.min = 0;
                    propAnimAmp.max = 25;
                    propAnimAmp.step = 0.1;
                }
                if (propAnimAmpVal) propAnimAmpVal.innerText = animAmp;
            } else if (animType === 'shake') {
                if (propAnimDirRow) propAnimDirRow.style.display = 'none';
                if (propAnimAmpLabel) propAnimAmpLabel.innerText = 'Amplitude (px)';
                if (propAnimAmp) {
                    propAnimAmp.min = 0;
                    propAnimAmp.max = 1000;
                    propAnimAmp.step = 1;
                }
                if (propAnimAmpVal) propAnimAmpVal.innerText = `${animAmp}px`;
            } else {
                if (propAnimDirRow) propAnimDirRow.style.display = 'block';
                if (propAnimAmpLabel) propAnimAmpLabel.innerText = 'Amplitude (px)';
                if (propAnimAmp) {
                    propAnimAmp.min = 0;
                    propAnimAmp.max = 5000;
                    propAnimAmp.step = 1;
                }
                if (propAnimAmpVal) propAnimAmpVal.innerText = `${animAmp}px`;
            }

            if (propAnimStartVal) propAnimStartVal.innerText = `${animStart.toFixed(2)}s`;
            if (propAnimEndVal) propAnimEndVal.innerText = `${animEnd.toFixed(2)}s`;
            if (propAnimDirVal) propAnimDirVal.innerText = `${animDir}°`;
            if (propAnimFreqVal) propAnimFreqVal.innerText = animFreq;
            if (propAnimPivotXVal) propAnimPivotXVal.innerText = pivotX;
            if (propAnimPivotYVal) propAnimPivotYVal.innerText = pivotY;

            let animArray = [];
            if (activeBlock.dataset.animateTool) {
                try {
                    animArray = JSON.parse(activeBlock.dataset.animateTool);
                    if (!Array.isArray(animArray)) {
                        animArray = [animArray];
                    }
                } catch(e) {}
            }

            const hasAnim = animAmp > 0;
            if (hasAnim) {
                const animObj = {
                    type: animType,
                    start_time: animStart,
                    end_time: animEnd,
                    direction_angle: animDir,
                    amplitude: animAmp,
                    periodicity: animFreq,
                    pivot: [pivotX, pivotY],
                    easing: animEasing
                };
                if (animArray.length > 0) {
                    animArray[0] = animObj;
                } else {
                    animArray.push(animObj);
                }
                activeBlock.dataset.animateTool = JSON.stringify(animArray);
            } else {
                if (animArray.length > 1) {
                    animArray[0].amplitude = 0;
                    activeBlock.dataset.animateTool = JSON.stringify(animArray);
                } else {
                    activeBlock.removeAttribute('data-animate-tool');
                    animArray = null;
                }
            }

            const clip = project.tracks.find(t => t.id === activeBlock.dataset.id);
            if (clip) {
                clip.scale = scale;
                clip.scaleX = scaleX;
                clip.scaleY = scaleY;
                clip.panX = panX;
                clip.panY = panY;
                clip.rotation = rotation;
                clip.opacity = opacity;
                clip.transitionIn = transInType;
                clip.fadeIn = transInDur;
                clip.transitionOut = transOutType;
                clip.fadeOut = transOutDur;
                clip.subprojDefaultTransition = subprojType;
                clip.subprojTransitionDuration = subprojDur;
                clip.subprojTransitionOverride = subprojOverride;
                clip.mirror = mirror;
                if (animArray && animArray.length > 0) {
                    clip.animate_tool = animArray;
                } else {
                    delete clip.animate_tool;
                }
            }

            // Instantly sync dynamic animateTool properties to active iframe element
            if (previewIframe && previewIframe.contentWindow) {
                try {
                    const hostDoc = previewIframe.contentDocument || previewIframe.contentWindow.document;
                    const el = hostDoc.querySelector(`[data-id="${activeBlock.dataset.id}"]`);
                    if (el) {
                        if (animArray && animArray.length > 0) {
                            el.dataset.animateTool = JSON.stringify(animArray);
                        } else {
                            delete el.dataset.animateTool;
                            el.removeAttribute('data-animate-tool');
                        }
                        if (typeof previewIframe.contentWindow.adjustScaling === 'function') {
                            previewIframe.contentWindow.adjustScaling();
                        }
                    }
                } catch(err) {}
            }
            
            localStorage.setItem(`htmlvr_unsaved_project_${currentProject}`, JSON.stringify(project));
            
            // Check if transition type/duration changed, or if it is a subproject setting, trigger debounced reload of preview iframe
            const isTransitionChange = e && (
                e.target === propTransInType || e.target === propTransInDuration ||
                e.target === propTransOutType || e.target === propTransOutDuration ||
                e.target === propSubprojTransType || e.target === propSubprojTransDuration || e.target === propSubprojTransOverride
            );
            
            if (isTransitionChange) {
                debouncedUpdatePreviewSource();
            } else {
                // Instantly update elements in the preview iframe in real-time
                if (previewIframe && previewIframe.contentWindow) {
                    try {
                        const hostDoc = previewIframe.contentDocument || previewIframe.contentWindow.document;
                        const hostEl = hostDoc.querySelector(`[data-id="${activeBlock.dataset.id}"]`);
                        if (hostEl) {
                            hostEl.dataset.scale = scale;
                            hostEl.dataset.scaleX = scaleX;
                            hostEl.dataset.scaleY = scaleY;
                            hostEl.dataset.panX = panX;
                            hostEl.dataset.panY = panY;
                            hostEl.dataset.rotation = rotation;
                            hostEl.dataset.opacity = opacity;
                            hostEl.dataset.transitionIn = transInType;
                            hostEl.dataset.fadeIn = transInDur;
                            hostEl.dataset.transitionOut = transOutType;
                            hostEl.dataset.fadeOut = transOutDur;
                            hostEl.dataset.mirror = mirror ? "true" : "false";
                            if (typeof previewIframe.contentWindow.adjustScaling === 'function') {
                                previewIframe.contentWindow.adjustScaling();
                            }
                        }
                    } catch(err) {
                        debouncedUpdatePreviewSource();
                    }
                }
            }
            
            updateViewportOutline();
            saveProjectStateToServerDebounced();
        }

        if (propScale) propScale.addEventListener('input', onPropSliderChange);
        if (propScaleX) propScaleX.addEventListener('input', onPropSliderChange);
        if (propScaleY) propScaleY.addEventListener('input', onPropSliderChange);
        if (propPanX) propPanX.addEventListener('input', onPropSliderChange);
        if (propPanY) propPanY.addEventListener('input', onPropSliderChange);
        if (propRotation) propRotation.addEventListener('input', onPropSliderChange);
        if (propOpacity) propOpacity.addEventListener('input', onPropSliderChange);
        if (propMirror) propMirror.addEventListener('change', onPropSliderChange);
        if (propTransInType) propTransInType.addEventListener('change', onPropSliderChange);
        if (propTransInDuration) propTransInDuration.addEventListener('input', onPropSliderChange);
        if (propTransOutType) propTransOutType.addEventListener('change', onPropSliderChange);
        if (propTransOutDuration) propTransOutDuration.addEventListener('input', onPropSliderChange);
        if (propSubprojTransType) propSubprojTransType.addEventListener('change', onPropSliderChange);
        if (propSubprojTransDuration) propSubprojTransDuration.addEventListener('input', onPropSliderChange);
        if (propSubprojTransOverride) propSubprojTransOverride.addEventListener('change', onPropSliderChange);

        // Bind animation properties change listeners
        if (propAnimType) propAnimType.addEventListener('change', onPropSliderChange);
        if (propAnimStart) propAnimStart.addEventListener('input', onPropSliderChange);
        if (propAnimEnd) propAnimEnd.addEventListener('input', onPropSliderChange);
        if (propAnimDir) propAnimDir.addEventListener('input', onPropSliderChange);
        if (propAnimAmp) propAnimAmp.addEventListener('input', onPropSliderChange);
        if (propAnimFreq) propAnimFreq.addEventListener('input', onPropSliderChange);
        if (propAnimPivotX) propAnimPivotX.addEventListener('input', onPropSliderChange);
        if (propAnimPivotY) propAnimPivotY.addEventListener('input', onPropSliderChange);

        // Accordion headers toggle functionality
        document.querySelectorAll('.accordion-header').forEach(header => {
            header.addEventListener('click', () => {
                const content = header.nextElementSibling;
                const icon = header.querySelector('.accordion-icon');
                if (content && content.classList.contains('accordion-content')) {
                    const isCollapsed = content.style.display === 'none';
                    if (isCollapsed) {
                        content.style.display = 'flex';
                        header.classList.add('active');
                        if (icon) icon.style.transform = 'rotate(0deg)';
                    } else {
                        content.style.display = 'none';
                        header.classList.remove('active');
                        if (icon) icon.style.transform = 'rotate(-90deg)';
                    }
                }
            });
        });

        const btnAnimateClip = document.getElementById('btn-animate-clip');
        if (btnAnimateClip) {
            btnAnimateClip.addEventListener('click', () => {
                const activeBlock = document.querySelector('.timeline-block.active');
                if (!activeBlock) {
                    showToast("Please select an image or video clip first.");
                    return;
                }
                const src = activeBlock.dataset.src || '';
                const isAudio = src.toLowerCase().endsWith('.mp3') || src.toLowerCase().endsWith('.wav') || src.toLowerCase().endsWith('.ogg');
                if (isAudio || src.startsWith('project:')) {
                    showToast("Can only animate local image or video clips.");
                    return;
                }
                if (window.AnimateTool) {
                    window.AnimateTool.open(activeBlock, currentProject, project, (updatedProject) => {
                        // Callback after successful animation
                        project.tracks = updatedProject.tracks;
                        project.markers = updatedProject.markers || [];
                        project.trackConfigs = updatedProject.trackConfigs || [];
                        
                        rebuildTracksUI();
                        updateProjectFromTimeline();
                        showToast("Sprite isolated and background inpainted!");
                    });
                } else {
                    showToast("Animate tool module not loaded yet.");
                }
            });
        }
        const btnGroupSelection = document.getElementById('btn-group-selection');
        if (btnGroupSelection) {
            btnGroupSelection.addEventListener('click', () => {
                if (btnGroupSelection.dataset.mode === 'ungroup') {
                    ungroupSelectedClips();
                } else {
                    groupSelectedClips();
                }
            });
        }
        if (btnCloseProperties) {
            btnCloseProperties.addEventListener('click', () => {
                // Clear active selections
                document.querySelectorAll('.timeline-block').forEach(b => b.classList.remove('active'));
                syncActiveClipToIframe();
            });
        }
        if (btnResetTransform) {
            btnResetTransform.addEventListener('click', () => {
                if (propScale) propScale.value = 1.0;
                if (propScaleX) propScaleX.value = 1.0;
                if (propScaleY) propScaleY.value = 1.0;
                if (propPanX) propPanX.value = 0;
                if (propPanY) propPanY.value = 0;
                if (propRotation) propRotation.value = 0;
                if (propOpacity) propOpacity.value = 1.0;
                if (propMirror) propMirror.checked = false;
                const activeBlock = document.querySelector('.timeline-block.active');
                if (activeBlock) {
                    activeBlock.dataset.rotation = 0;
                    activeBlock.dataset.opacity = 1.0;
                    activeBlock.dataset.mirror = "false";
                    const clip = project.tracks.find(t => t.id === activeBlock.dataset.id);
                    if (clip) {
                        clip.rotation = 0;
                        clip.opacity = 1.0;
                        clip.mirror = false;
                    }
                }
                onPropSliderChange();
            });
        }
        const btnSidebarDeleteClip = document.getElementById('btn-sidebar-delete-clip');
        if (btnSidebarDeleteClip) {
            btnSidebarDeleteClip.addEventListener('click', () => {
                deleteActiveClips();
            });
        }

        if (btnRippleToggle) {
            btnRippleToggle.addEventListener('click', () => {
                if (rippleMode === 'off') {
                    rippleMode = 'track';
                    btnRippleToggle.style.borderColor = '#f59e0b';
                    btnRippleToggle.style.color = '#f59e0b';
                    btnRippleToggle.querySelector('span').innerText = 'Ripple Track';
                    btnRippleToggle.title = 'Ripple Edit: Single Track (Click to toggle)';
                } else if (rippleMode === 'track') {
                    rippleMode = 'all';
                    btnRippleToggle.style.borderColor = '#00f0ff';
                    btnRippleToggle.style.color = '#00f0ff';
                    btnRippleToggle.querySelector('span').innerText = 'Ripple All';
                    btnRippleToggle.title = 'Ripple Edit: All Tracks (Click to toggle)';
                } else {
                    rippleMode = 'off';
                    btnRippleToggle.style.borderColor = '#64748b';
                    btnRippleToggle.style.color = '#64748b';
                    btnRippleToggle.querySelector('span').innerText = 'Ripple Off';
                    btnRippleToggle.title = 'Ripple Edit: OFF (Click to toggle)';
                }
                showToast(`Ripple mode set to: ${rippleMode.toUpperCase()}`);
            });
        }

        function cloneActiveClip() {
            const activeBlock = document.querySelector('.timeline-block.active');
            if (!activeBlock) {
                showToast("Please select a clip to clone.");
                return;
            }

            const originalClip = project.tracks.find(t => t.id === activeBlock.dataset.id);
            if (!originalClip) return;

            const start = originalClip.start;
            const duration = originalClip.duration;
            const currentTrackIndex = parseInt(originalClip.trackIndex);
            const numTracks = project.trackConfigs.length;

            function isRangeOccupied(trackIndex, start, duration) {
                return project.tracks.some(t => {
                    if (parseInt(t.trackIndex) !== parseInt(trackIndex)) return false;
                    const end = start + duration;
                    const tEnd = t.start + t.duration;
                    return (start < tEnd - 0.05) && (t.start < end - 0.05);
                });
            }

            let targetTrackIndex = -1;
            // 1. Check if track below (T + 1) exists and is free
            if (currentTrackIndex + 1 < numTracks && !isRangeOccupied(currentTrackIndex + 1, start, duration)) {
                targetTrackIndex = currentTrackIndex + 1;
            }
            // 2. Otherwise check if track above (T - 1) exists and is free
            else if (currentTrackIndex - 1 >= 0 && !isRangeOccupied(currentTrackIndex - 1, start, duration)) {
                targetTrackIndex = currentTrackIndex - 1;
            }
            // 3. Otherwise (neighbors occupied or T+1 out of bounds), create a new track right below currentTrackIndex
            else {
                insertTrackAt(currentTrackIndex + 1);
                targetTrackIndex = currentTrackIndex + 1;
            }

            // Create deep copy of cloned clip state
            const newId = `clip_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
            const clonedClip = JSON.parse(JSON.stringify(originalClip));
            clonedClip.id = newId;
            clonedClip.trackIndex = targetTrackIndex;

            project.tracks.push(clonedClip);

            // Rebuild UI, sync state and update
            rebuildTracksUI();
            updateProjectFromTimeline();
            showToast("Clip cloned successfully!");

            // Focus and select the newly cloned clip
            setTimeout(() => {
                const newBlock = document.querySelector(`.timeline-block[data-id="${newId}"]`);
                if (newBlock) {
                    selectClipBlock(newBlock);
                }
            }, 50);
        }



        const btnSidebarCloneClip = document.getElementById('btn-sidebar-clone-clip');
        if (btnSidebarCloneClip) {
            btnSidebarCloneClip.addEventListener('click', cloneActiveClip);
        }

        // Overlay outline mouse/wheel interaction handlers
        if (viewportActiveOutline) {
            let isDraggingOutline = false;
            let dragStartMouseX = 0;
            let dragStartMouseY = 0;
            let dragStartPanX = 0;
            let dragStartPanY = 0;

            let isRotatingOutline = false;
            let rotateStartMouseX = 0;
            let rotateStartRotation = 0;

            viewportActiveOutline.addEventListener('mousedown', (e) => {
                const activeBlock = document.querySelector('.timeline-block.active');
                if (!activeBlock) return;

                // Check if user clicked the rotation handle in the center
                const rotateHandle = e.target.closest('.rotate-handle');
                if (rotateHandle) {
                    e.preventDefault();
                    e.stopPropagation();
                    isRotatingOutline = true;
                    rotateStartMouseX = e.clientX;
                    rotateStartRotation = parseFloat(activeBlock.dataset.rotation) || 0;
                    document.body.style.cursor = 'ew-resize';

                    document.addEventListener('mousemove', onOutlineMouseMove);
                    document.addEventListener('mouseup', onOutlineMouseUp);
                    return;
                }

                // Otherwise drag/translate the clip
                e.preventDefault();
                isDraggingOutline = true;
                dragStartMouseX = e.clientX;
                dragStartMouseY = e.clientY;
                dragStartPanX = parseFloat(activeBlock.dataset.panX) || 0;
                dragStartPanY = parseFloat(activeBlock.dataset.panY) || 0;

                document.addEventListener('mousemove', onOutlineMouseMove);
                document.addEventListener('mouseup', onOutlineMouseUp);
            });

            // Prevent scroll on the outline and zoom instead (exponential zoom for smooth experience)
            viewportActiveOutline.addEventListener('wheel', (e) => {
                const activeBlock = document.querySelector('.timeline-block.active');
                if (!activeBlock) return;

                e.preventDefault();
                e.stopPropagation();

                const zoomFactor = Math.exp(-e.deltaY * 0.00005);
                let newScale = (parseFloat(activeBlock.dataset.scale) || 1.0) * zoomFactor;
                newScale = Math.max(0.1, Math.min(10.0, newScale));

                let newScaleX = (parseFloat(activeBlock.dataset.scaleX) || parseFloat(activeBlock.dataset.scale) || 1.0) * zoomFactor;
                newScaleX = Math.max(0.1, Math.min(10.0, newScaleX));

                let newScaleY = (parseFloat(activeBlock.dataset.scaleY) || parseFloat(activeBlock.dataset.scale) || 1.0) * zoomFactor;
                newScaleY = Math.max(0.1, Math.min(10.0, newScaleY));

                activeBlock.dataset.scale = newScale;
                activeBlock.dataset.scaleX = newScaleX;
                activeBlock.dataset.scaleY = newScaleY;
                if (propScale) {
                    propScale.value = newScale;
                    if (propScaleVal) propScaleVal.innerText = newScale.toFixed(2);
                }
                if (propScaleX) {
                    propScaleX.value = newScaleX;
                    if (propScaleXVal) propScaleXVal.innerText = newScaleX.toFixed(2);
                }
                if (propScaleY) {
                    propScaleY.value = newScaleY;
                    if (propScaleYVal) propScaleYVal.innerText = newScaleY.toFixed(2);
                }

                const clip = project.tracks.find(t => t.id === activeBlock.dataset.id);
                if (clip) {
                    clip.scale = newScale;
                    clip.scaleX = newScaleX;
                    clip.scaleY = newScaleY;
                }

                localStorage.setItem(`htmlvr_unsaved_project_${currentProject}`, JSON.stringify(project));

                // Instantly update iframe
                if (previewIframe && previewIframe.contentWindow) {
                    try {
                        const hostDoc = previewIframe.contentDocument || previewIframe.contentWindow.document;
                        const hostEl = hostDoc.querySelector(`[data-id="${activeBlock.dataset.id}"]`);
                        if (hostEl) {
                            hostEl.dataset.scale = newScale;
                            hostEl.dataset.scaleX = newScaleX;
                            hostEl.dataset.scaleY = newScaleY;
                            if (typeof previewIframe.contentWindow.adjustScaling === 'function') {
                                previewIframe.contentWindow.adjustScaling();
                            }
                        }
                    } catch(err) {}
                }

                updateViewportOutline();
                saveProjectStateToServerDebounced();
            }, { passive: false });

            function onOutlineMouseMove(e) {
                const activeBlock = document.querySelector('.timeline-block.active');
                if (!activeBlock) return;

                if (isDraggingOutline) {
                    const dx = e.clientX - dragStartMouseX;
                    const dy = e.clientY - dragStartMouseY;
                    
                    const rect = previewIframe.getBoundingClientRect();
                    // panX/panY are always stored in the virtual 1920x1080 design space for HTML clips.
                    // For video/image clips they are stored in the current render resolution space.
                    const src = activeBlock.dataset.src || '';
                    const isHtmlClip = !src.toLowerCase().match(/\.(mp4|webm|mp3|wav|ogg|png|jpg|jpeg|gif)$/);
                    const designW = isHtmlClip ? 1920 : settings.width;
                    const designH = isHtmlClip ? 1080 : settings.height;
                    const viewportScale = Math.min(rect.width / designW, rect.height / designH);

                    const newPanX = dragStartPanX + dx / viewportScale;
                    const newPanY = dragStartPanY + dy / viewportScale;

                    activeBlock.dataset.panX = newPanX;
                    activeBlock.dataset.panY = newPanY;

                    if (propPanX) { propPanX.value = newPanX; propPanXVal.innerText = Math.round(newPanX); }
                    if (propPanY) { propPanY.value = newPanY; propPanYVal.innerText = Math.round(newPanY); }

                    const clip = project.tracks.find(t => t.id === activeBlock.dataset.id);
                    if (clip) {
                        clip.panX = newPanX;
                        clip.panY = newPanY;
                    }

                    // Instantly update iframe
                    if (previewIframe && previewIframe.contentWindow) {
                        try {
                            const hostDoc = previewIframe.contentDocument || previewIframe.contentWindow.document;
                            const hostEl = hostDoc.querySelector(`[data-id="${activeBlock.dataset.id}"]`);
                            if (hostEl) {
                                hostEl.dataset.panX = newPanX;
                                hostEl.dataset.panY = newPanY;
                                if (typeof previewIframe.contentWindow.adjustScaling === 'function') {
                                    previewIframe.contentWindow.adjustScaling();
                                }
                            }
                        } catch(err) {}
                    }
                    updateViewportOutline();
                } else if (isRotatingOutline) {
                    const dx = e.clientX - rotateStartMouseX;
                    let angleDiff = dx * 0.05; // 0.05 degrees per pixel for high precision!
                    let newRotation = rotateStartRotation + angleDiff;

                    // Snap to 15-degree increments if Shift is held
                    if (e.shiftKey) {
                        newRotation = Math.round(newRotation / 15) * 15;
                    }

                    // Normalize to 0-360 range for clean presentation
                    newRotation = (newRotation % 360 + 360) % 360;

                    activeBlock.dataset.rotation = newRotation;

                    // Update rotation slider and text value
                    if (propRotation) {
                        let rotVal = newRotation;
                        while (rotVal > 180) rotVal -= 360;
                        while (rotVal < -180) rotVal += 360;
                        propRotation.value = Math.round(rotVal);
                        if (propRotationVal) propRotationVal.innerText = `${Math.round(rotVal)}°`;
                    }

                    const clip = project.tracks.find(t => t.id === activeBlock.dataset.id);
                    if (clip) {
                        clip.rotation = newRotation;
                    }

                    // Instantly update iframe
                    if (previewIframe && previewIframe.contentWindow) {
                        try {
                            const hostDoc = previewIframe.contentDocument || previewIframe.contentWindow.document;
                            const hostEl = hostDoc.querySelector(`[data-id="${activeBlock.dataset.id}"]`);
                            if (hostEl) {
                                hostEl.dataset.rotation = newRotation;
                                if (typeof previewIframe.contentWindow.adjustScaling === 'function') {
                                    previewIframe.contentWindow.adjustScaling();
                                }
                            }
                        } catch(err) {}
                    }
                    updateViewportOutline();
                }
            }

            function onOutlineMouseUp() {
                if (isDraggingOutline || isRotatingOutline) {
                    isDraggingOutline = false;
                    isRotatingOutline = false;
                    document.body.style.cursor = '';
                    document.removeEventListener('mousemove', onOutlineMouseMove);
                    document.removeEventListener('mouseup', onOutlineMouseUp);
                    
                    localStorage.setItem(`htmlvr_unsaved_project_${currentProject}`, JSON.stringify(project));
                    saveProjectStateToServerDebounced();
                }
            }
        }

        // Vertical scroll synchronization between track headers and rows
        tracksContainer.addEventListener('scroll', () => {
            const headersList = document.querySelector('.track-headers-list');
            if (headersList) {
                headersList.scrollTop = tracksContainer.scrollTop;
            }
            updatePlayheadVertical();
        });
        window.addEventListener('resize', updatePlayheadVertical);

        // Add wheel scroll synchronization for the left track headers column
        const trackHeaderCol = document.querySelector('.track-header-col');
        if (trackHeaderCol && tracksContainer) {
            trackHeaderCol.addEventListener('wheel', (e) => {
                let scrollAmount = e.deltaY;
                if (e.deltaMode === 1) { // Lines (Firefox fallback)
                    scrollAmount *= 25;
                } else if (e.deltaMode === 2) { // Pages
                    scrollAmount *= 400;
                } else if (Math.abs(scrollAmount) < 20) {
                    // Trackpads / high precision scrolling normalization
                    scrollAmount *= 5;
                }
                tracksContainer.scrollTop += scrollAmount;
            }, { passive: true });
        }

        playheadSlider.addEventListener('input', (e) => {
            seekTo(parseFloat(e.target.value));
        });

        if (selectResolution) {
            selectResolution.addEventListener('change', () => {
                const resStr = selectResolution.value;
                const [w, h] = resStr.split('x').map(x => parseInt(x));
                settings.width = w;
                settings.height = h;
                updatePreviewSource();
            });
        }

        btnPlayPause.addEventListener('click', togglePlay);
        if (btnFullscreen && canvasContainer) {
            btnFullscreen.addEventListener('click', () => {
                if (!document.fullscreenElement) {
                    canvasContainer.requestFullscreen().catch(err => {
                        console.error(`Error attempting to enable fullscreen: ${err.message}`);
                    });
                } else {
                    document.exitFullscreen();
                }
            });

            document.addEventListener('fullscreenchange', () => {
                const isFullscreen = !!document.fullscreenElement;
                if (isFullscreen) {
                    btnFullscreen.classList.add('is-fullscreen');
                    btnFullscreen.querySelector('.icon-enter').style.display = 'none';
                    btnFullscreen.querySelector('.icon-exit').style.display = 'block';
                    btnFullscreen.title = 'Exit Fullscreen';
                } else {
                    btnFullscreen.classList.remove('is-fullscreen');
                    btnFullscreen.querySelector('.icon-enter').style.display = 'block';
                    btnFullscreen.querySelector('.icon-exit').style.display = 'none';
                    btnFullscreen.title = 'Toggle Fullscreen';
                }
            });
        }

        const btnFullscreenMenu = document.getElementById('btn-fullscreen-menu');
        if (btnFullscreenMenu && canvasContainer) {
            btnFullscreenMenu.addEventListener('click', () => {
                if (btnFullscreen) {
                    btnFullscreen.click();
                }
            });
        }
        


        // Global keyboard shortcut controls
        document.addEventListener('keydown', (e) => {
            // Ignore editor shortcuts if the animate tool overlay is open
            if (document.getElementById('animate-tool-overlay')) {
                return;
            }

            const active = document.activeElement;
            if (active && (
                active.tagName === 'TEXTAREA' || 
                active.tagName === 'SELECT' || 
                (active.tagName === 'INPUT' && (active.type === 'text' || active.type === 'number' || active.type === 'password' || active.type === 'email'))
            )) {
                return;
            }

            if (e.code === 'Escape') {
                e.preventDefault();
                document.querySelectorAll('.track-header.selected').forEach(h => h.classList.remove('selected'));
                document.querySelectorAll('.timeline-block.active').forEach(b => b.classList.remove('active'));
                syncActiveClipToIframe();
                propagateTrackSelectionToPreview();
                if (typeof updateMasterCompressorVisuals === 'function') {
                    updateMasterCompressorVisuals();
                }
            } else if (e.code === 'KeyW') {
                e.preventDefault();
                seekTo(0.0);
            } else if (e.code === 'ArrowLeft') {
                e.preventDefault();
                if (project.markers && project.markers.length > 0) {
                    const sortedMarkers = [...project.markers].sort((a, b) => a.time - b.time);
                    const leftMarkers = sortedMarkers.filter(m => m.time < playheadTime - 0.005);
                    if (leftMarkers.length > 0) {
                        const closestIdx = leftMarkers.length - 1;
                        const closestMarker = leftMarkers[closestIdx];
                        
                        // If within 1 second of the closest marker, skip to the one before it
                        if (playheadTime - closestMarker.time <= 1.0) {
                            if (closestIdx > 0) {
                                seekTo(leftMarkers[closestIdx - 1].time);
                            } else {
                                seekTo(0.0);
                            }
                        } else {
                            seekTo(closestMarker.time);
                        }
                    } else {
                        seekTo(0.0);
                    }
                } else {
                    seekTo(0.0);
                }
            } else if (e.code === 'ArrowRight') {
                e.preventDefault();
                if (project.markers && project.markers.length > 0) {
                    let targetMarker = null;
                    const sortedMarkers = [...project.markers].sort((a, b) => a.time - b.time);
                    for (let i = 0; i < sortedMarkers.length; i++) {
                        if (sortedMarkers[i].time > playheadTime + 0.005) {
                            targetMarker = sortedMarkers[i];
                            break;
                        }
                    }
                    if (targetMarker) {
                        seekTo(targetMarker.time);
                    }
                }
            } else if (e.code === 'Space') {
                e.preventDefault();
                if (active && (active.tagName === 'INPUT' || active.tagName === 'BUTTON' || active.tagName === 'A')) {
                    active.blur();
                }
                togglePlay();
            } else if (e.code === 'KeyS') {
                e.preventDefault();
                splitActiveClipsAtPlayhead();
            } else if (e.code === 'Delete') {
                e.preventDefault();
                const selectedHeaders = document.querySelectorAll('.track-header.selected');
                if (selectedHeaders.length > 0) {
                    const indices = Array.from(selectedHeaders)
                        .map(h => parseInt(h.dataset.trackIndex))
                        .sort((a, b) => b - a);
                    
                    if (confirm(`Are you sure you want to delete the ${indices.length} selected track(s)? All clips on them will be removed.`)) {
                        pushUndoState();
                        indices.forEach(idx => {
                            deleteTrackAt(idx, true);
                        });
                        rebuildTracksUI();
                        updateProjectFromTimeline(true);
                    }
                } else {
                    deleteActiveClips();
                }
            } else if (e.code === 'KeyZ' && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                if (e.shiftKey) {
                    redo();
                } else {
                    undo();
                }
            } else if (e.code === 'KeyY' && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                redo();
            }
        });

        // Interactive playhead drag and timeline click-to-seek
        isDraggingPlayhead = false;
        let playheadMoved = false;
        let dragStartedOnHandle = false;

        function handlePlayheadMove(clientX) {
            const rect = tracksContainer.getBoundingClientRect();
            const x = clientX - rect.left + tracksContainer.scrollLeft - TIMELINE_OFFSET;
            const time = Math.max(0, x / PX_PER_SECOND);
            seekTo(time);
        }

        if (playheadHandle) {
            playheadHandle.addEventListener('mousedown', (e) => {
                e.preventDefault();
                e.stopPropagation();
                isDraggingPlayhead = true;
                playheadMoved = false;
                dragStartedOnHandle = true;
                document.addEventListener('mousemove', onPlayheadMouseMove);
                document.addEventListener('mouseup', onPlayheadMouseUp);
            });
        }

        timelineRuler.addEventListener('mousedown', (e) => {
            e.preventDefault();
            handlePlayheadMove(e.clientX);
            isDraggingPlayhead = true;
            playheadMoved = false;
            dragStartedOnHandle = false;
            document.addEventListener('mousemove', onPlayheadMouseMove);
            document.addEventListener('mouseup', onPlayheadMouseUp);
        });

        tracksContainer.addEventListener('mousedown', (e) => {
            if (e.target === tracksContainer || e.target.classList.contains('track-row')) {
                e.preventDefault();
                // Clear active selections
                document.querySelectorAll('.timeline-block').forEach(b => b.classList.remove('active'));
                syncActiveClipToIframe();
                
                handlePlayheadMove(e.clientX);
                isDraggingPlayhead = true;
                playheadMoved = false;
                dragStartedOnHandle = false;
                document.addEventListener('mousemove', onPlayheadMouseMove);
                document.addEventListener('mouseup', onPlayheadMouseUp);
            }
        });

        function onPlayheadMouseMove(e) {
            if (isDraggingPlayhead) {
                playheadMoved = true;
                handlePlayheadMove(e.clientX);
            }
        }

        function onPlayheadMouseUp() {
            if (isDraggingPlayhead) {
                isDraggingPlayhead = false;
                document.removeEventListener('mousemove', onPlayheadMouseMove);
                document.removeEventListener('mouseup', onPlayheadMouseUp);

                // If user clicked the playhead handle + without dragging, open comment modal
                if (dragStartedOnHandle && !playheadMoved) {
                    openCommentModal(null, playheadTime);
                }
            }
        }

        // Render dropdown toggle and close on click outside
        if (btnRenderToggle && renderDropdownMenu) {
            btnRenderToggle.addEventListener('click', (e) => {
                e.stopPropagation();
                renderDropdownMenu.classList.toggle('show');
            });

            document.addEventListener('click', (e) => {
                if (!renderDropdownMenu.contains(e.target) && e.target !== btnRenderToggle) {
                    renderDropdownMenu.classList.remove('show');
                }
            });
        }

        // Floating Right-Side Menu Trigger & Drawer Panel handling
        const menuTriggerBtn = document.getElementById('menu-trigger-btn');
        const btnCloseMenu = document.getElementById('btn-close-menu');
        const toolbarMenuWidget = document.getElementById('toolbar-menu-widget');

        if (menuTriggerBtn && toolbarMenuWidget) {
            menuTriggerBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                const show = toolbarMenuWidget.classList.toggle('show');
                menuTriggerBtn.innerHTML = show ? '›' : '‹';
            });
        }

        if (btnCloseMenu && toolbarMenuWidget) {
            btnCloseMenu.addEventListener('click', (e) => {
                e.stopPropagation();
                toolbarMenuWidget.classList.remove('show');
                if (menuTriggerBtn) menuTriggerBtn.innerHTML = '‹';
            });
        }

        if (toolbarMenuWidget) {
            // Prevent clicks inside the widget from closing it
            toolbarMenuWidget.addEventListener('click', (e) => {
                e.stopPropagation();
            });

            // Close the widget when clicking outside
            document.addEventListener('click', () => {
                toolbarMenuWidget.classList.remove('show');
                if (menuTriggerBtn) menuTriggerBtn.innerHTML = '‹';
            });
        }

        if (btnSendAgent) {
            btnSendAgent.addEventListener('click', async () => {
                const activeMarkers = (project.markers || []).filter(m => !m.text.trim().startsWith('[done]'));
                if (activeMarkers.length === 0) {
                    alert("There are no active comments/directives for the AI Agent. Please click the '+' playhead handle on the timeline ruler to add a comment with instructions (e.g. '/narrate Welcome to HtmlVR' or '/slide Title | Description'), then click Send to Agent again.");
                    return;
                }

                try {
                    const res = await fetch(`/api/agent/trigger?project=${encodeURIComponent(currentProject)}`, {
                        method: 'POST'
                    });
                    if (!res.ok) throw new Error("Server rejected trigger.");
                    const data = await res.json();
                    if (data.success) {
                        showToast("Sent trigger to Agent Conductor!");
                    } else {
                        showToast("Failed to trigger agent.");
                    }
                } catch (e) {
                    console.error("Agent trigger error:", e);
                    showToast("Error triggering agent: " + e.message);
                }
            });
        }

        if (btnSwitchProject) {
            btnSwitchProject.addEventListener('click', async () => {
                projectListContainer.innerHTML = '<div style="color: #64748b; font-size: 13px; text-align: center; padding: 15px;">Loading projects...</div>';
                customProjectInput.value = '';
                projectModal.style.display = 'flex';
                
                try {
                    const res = await fetch('/api/projects');
                    const data = await res.json();
                    projectListContainer.innerHTML = '';
                    
                    if (data.projects && data.projects.length > 0) {
                        data.projects.forEach(projName => {
                            const item = document.createElement('div');
                            item.className = 'project-list-item';
                            item.style.padding = '8px 12px';
                            item.style.background = '#1e293b';
                            item.style.border = '1px solid rgba(255, 255, 255, 0.05)';
                            item.style.borderRadius = '4px';
                            item.style.display = 'flex';
                            item.style.justifyContent = 'space-between';
                            item.style.alignItems = 'center';
                            item.style.transition = 'all 0.15s ease';
                            
                            const nameSpan = document.createElement('span');
                            nameSpan.innerText = projName;
                            nameSpan.style.cursor = 'pointer';
                            nameSpan.style.flexGrow = '1';
                            nameSpan.style.fontSize = '13px';
                            nameSpan.style.fontWeight = 'bold';
                            nameSpan.style.color = '#fff';
                            nameSpan.style.transition = 'color 0.15s';
                            
                            item.addEventListener('mouseenter', () => {
                                item.style.background = 'rgba(0, 240, 255, 0.1)';
                                item.style.borderColor = '#00f0ff';
                                item.style.boxShadow = '0 0 8px rgba(0, 240, 255, 0.1)';
                                nameSpan.style.color = '#00f0ff';
                            });
                            item.addEventListener('mouseleave', () => {
                                item.style.background = '#1e293b';
                                item.style.borderColor = 'rgba(255, 255, 255, 0.05)';
                                item.style.boxShadow = 'none';
                                nameSpan.style.color = '#fff';
                            });
                            
                            nameSpan.addEventListener('click', () => {
                                projectModal.style.display = 'none';
                                window.location.search = `?project=${encodeURIComponent(projName)}`;
                            });
                            item.appendChild(nameSpan);
                            
                            if (projName !== currentProject) {
                                const insertBtn = document.createElement('button');
                                insertBtn.innerText = 'Insert as Clip';
                                insertBtn.style.background = '#8a2be2';
                                insertBtn.style.border = 'none';
                                insertBtn.style.color = '#fff';
                                insertBtn.style.padding = '4px 10px';
                                insertBtn.style.borderRadius = '3px';
                                insertBtn.style.fontSize = '11px';
                                insertBtn.style.cursor = 'pointer';
                                insertBtn.style.fontWeight = 'bold';
                                insertBtn.style.transition = 'background 0.2s';
                                
                                insertBtn.addEventListener('mouseenter', (e) => {
                                    e.stopPropagation();
                                    insertBtn.style.background = '#9d4edd';
                                });
                                insertBtn.addEventListener('mouseleave', (e) => {
                                    e.stopPropagation();
                                    insertBtn.style.background = '#8a2be2';
                                });
                                
                                insertBtn.addEventListener('click', async (e) => {
                                    e.stopPropagation();
                                    projectModal.style.display = 'none';
                                    
                                    const duration = await getProjectDuration(projName);
                                    createTimelineBlock(
                                        `project:${projName}`,
                                        `Subproject: ${projName}`,
                                        playheadTime,
                                        duration,
                                        0
                                    );
                                    updateProjectFromTimeline();
                                    showToast(`Inserted subproject "${projName}" on Track 1`);
                                });
                                item.appendChild(insertBtn);
                            }
                            
                            projectListContainer.appendChild(item);
                        });
                    } else {
                        projectListContainer.innerHTML = '<div style="color: #64748b; font-size: 13px; text-align: center; padding: 15px;">No existing projects.</div>';
                    }
                } catch (e) {
                    console.error("Failed to list projects:", e);
                    projectListContainer.innerHTML = `<div style="color: #ef4444; font-size: 13px; text-align: center; padding: 15px;">Error: ${e.message}</div>`;
                }
            });
        }

        if (btnProjectCancel) {
            btnProjectCancel.addEventListener('click', () => {
                projectModal.style.display = 'none';
            });
        }

        if (btnProjectGo) {
            btnProjectGo.addEventListener('click', () => {
                const name = customProjectInput.value.trim();
                if (name) {
                    const sanitized = name.replace(/[^a-zA-Z0-9\-_]/g, '_');
                    projectModal.style.display = 'none';
                    window.location.search = `?project=${encodeURIComponent(sanitized)}`;
                } else {
                    alert("Please select a project from the list or enter a new name.");
                }
            });
        }

        if (customProjectInput) {
            customProjectInput.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') {
                    btnProjectGo.click();
                }
            });
        }

        // Configure playhead slider max duration dynamically
        updatePlayheadSliderRange();

        // Zoom timeline with Mouse Wheel (relative to cursor position) by default (Reaper style), scroll vertically on Ctrl, scroll horizontally on Shift
        tracksContainer.addEventListener('wheel', (e) => {
            if (e.ctrlKey) {
                // Scroll vertically (default in browser is page zoom, so we MUST preventDefault)
                e.preventDefault();
                let scrollAmount = e.deltaY;
                if (e.deltaMode === 1) { // Lines
                    scrollAmount *= 25;
                } else if (e.deltaMode === 2) { // Pages
                    scrollAmount *= 400;
                } else if (Math.abs(scrollAmount) < 20) {
                    scrollAmount *= 5;
                }
                tracksContainer.scrollTop += scrollAmount;
            } else if (e.shiftKey) {
                // Scroll horizontally
                e.preventDefault();
                let scrollAmount = e.deltaY;
                if (e.deltaMode === 1) { // Lines
                    scrollAmount *= 25;
                } else if (e.deltaMode === 2) { // Pages
                    scrollAmount *= 400;
                } else if (Math.abs(scrollAmount) < 20) {
                    scrollAmount *= 5;
                }
                tracksContainer.scrollLeft += scrollAmount;
            } else {
                // Zoom timeline horizontally (speed-sensitive exponential zoom)
                e.preventDefault();
                const absDelta = Math.abs(e.deltaY);
                // Exponent scales with scroll intensity: standard 100 delta gives a 0.3 exponent (approx. 2x faster than original 1.15 zoom factor)
                const exponent = Math.max(1, absDelta / 50) * 0.15;
                const zoomFactor = e.deltaY < 0 ? (1 + exponent) : (1 / (1 + exponent));
                
                // Get mouse position relative to tracksContainer
                const rect = tracksContainer.getBoundingClientRect();
                const mouseX = e.clientX - rect.left;
                
                // Calculate time under cursor before zoom
                const timeAtCursor = (mouseX + tracksContainer.scrollLeft - TIMELINE_OFFSET) / PX_PER_SECOND;
                
                const minPx = Math.max(0.01, Math.min(10, (tracksContainer.clientWidth - TIMELINE_OFFSET - 50) / MAX_DURATION));
                const newPxPerSecond = Math.max(minPx, Math.min(200, PX_PER_SECOND * zoomFactor));
                if (newPxPerSecond !== PX_PER_SECOND) {
                    PX_PER_SECOND = newPxPerSecond;
                    updateTimelineZoom();
                    
                    // Keep the cursor position stable
                    tracksContainer.scrollLeft = TIMELINE_OFFSET + timeAtCursor * PX_PER_SECOND - mouseX;
                }
            }
        }, { passive: false });

        // Touch Pinch-to-Zoom logic
        let initialDistance = 0;
        let initialPxPerSecond = 0;
        let timeAtCenter = 0;
        let isPinching = false;

        tracksContainer.addEventListener('touchstart', (e) => {
            if (e.touches.length === 2) {
                isPinching = true;
                const touch1 = e.touches[0];
                const touch2 = e.touches[1];
                
                // Calculate distance between the two touches
                initialDistance = Math.hypot(touch1.clientX - touch2.clientX, touch1.clientY - touch2.clientY);
                initialPxPerSecond = PX_PER_SECOND;
                
                // Calculate center point of the pinch relative to container viewport
                const rect = tracksContainer.getBoundingClientRect();
                const centerX = (touch1.clientX + touch2.clientX) / 2;
                const mouseX = centerX - rect.left;
                
                // Time under the center point before zooming
                timeAtCenter = (mouseX + tracksContainer.scrollLeft - TIMELINE_OFFSET) / PX_PER_SECOND;
            }
        }, { passive: true });

        tracksContainer.addEventListener('touchmove', (e) => {
            if (isPinching && e.touches.length === 2) {
                if (e.cancelable) {
                    e.preventDefault();
                }
                
                const touch1 = e.touches[0];
                const touch2 = e.touches[1];
                const currentDistance = Math.hypot(touch1.clientX - touch2.clientX, touch1.clientY - touch2.clientY);
                
                if (initialDistance > 10) {
                    const zoomFactor = currentDistance / initialDistance;
                    const minPx = Math.max(0.01, Math.min(10, (tracksContainer.clientWidth - TIMELINE_OFFSET - 50) / MAX_DURATION));
                    const newPxPerSecond = Math.max(minPx, Math.min(200, initialPxPerSecond * zoomFactor));
                    
                    if (newPxPerSecond !== PX_PER_SECOND) {
                        PX_PER_SECOND = newPxPerSecond;
                        updateTimelineZoom();
                        
                        // Keep center of the pinch stable
                        const rect = tracksContainer.getBoundingClientRect();
                        const currentCenterX = (touch1.clientX + touch2.clientX) / 2;
                        const currentMouseX = currentCenterX - rect.left;
                        tracksContainer.scrollLeft = TIMELINE_OFFSET + timeAtCenter * PX_PER_SECOND - currentMouseX;
                    }
                }
            }
        }, { passive: false });

        const endPinch = () => {
            isPinching = false;
        };

        tracksContainer.addEventListener('touchend', endPinch);
        tracksContainer.addEventListener('touchcancel', endPinch);

        // Project Save Button Click (Export ZIP Package)
        btnSaveProject.addEventListener('click', async () => {
            try {
                const res = await fetch(`/api/project/export?project=${encodeURIComponent(currentProject)}`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(project)
                });
                if (!res.ok) throw new Error("Server export failed.");
                
                const blob = await res.blob();
                const downloadUrl = window.URL.createObjectURL(blob);
                const downloadAnchor = document.createElement('a');
                downloadAnchor.href = downloadUrl;
                downloadAnchor.download = `htmlvr_project_${currentProject}_${Date.now()}.zip`;
                document.body.appendChild(downloadAnchor);
                downloadAnchor.click();
                downloadAnchor.remove();
                window.URL.revokeObjectURL(downloadUrl);
            } catch (err) {
                alert("Export failed: " + err.message);
            }
        });

        // Project Load Button Click (Import ZIP Package)
        btnLoadProject.addEventListener('click', () => {
            const fileInput = document.createElement('input');
            fileInput.type = 'file';
            fileInput.accept = '.zip';
            fileInput.onchange = (e) => {
                const file = e.target.files[0];
                if (!file) return;
                const reader = new FileReader();
                reader.onload = async (evt) => {
                    try {
                        const arrayBuffer = evt.target.result;
                        const base64 = btoa(
                            new Uint8Array(arrayBuffer)
                                .reduce((data, byte) => data + String.fromCharCode(byte), '')
                        );
                        
                        const res = await fetch(`/api/project/import?project=${encodeURIComponent(currentProject)}`, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ zipData: base64 })
                        });
                        const result = await res.json();
                        if (result.success && result.project) {
                            project.tracks = result.project.tracks;
                            project.markers = result.project.markers || [];
                            project.trackConfigs = result.project.trackConfigs || [];
                            rebuildTimelineFromProject();
                            localStorage.setItem(`htmlvr_unsaved_project_${currentProject}`, JSON.stringify(project));
                            
                            // Reload sidebar compositions list
                            await loadCompositions();
                            
                            alert("Project package imported successfully.");
                        } else {
                            alert("Import failed: " + (result.error || "unknown error"));
                        }
                    } catch (err) {
                        alert("Error importing project zip: " + err.message);
                    }
                };
                reader.readAsArrayBuffer(file);
            };
            fileInput.click();
        });



        // Undo Project Reset Button Click
        if (btnUndoProject) {
            btnUndoProject.addEventListener('click', async () => {
                try {
                    const res = await fetch(`/api/project/undo?project=${encodeURIComponent(currentProject)}`, { method: 'POST' });
                    const result = await res.json();
                    if (result.success && result.project) {
                        project.tracks = result.project.tracks;
                        project.markers = result.project.markers || [];
                        project.trackConfigs = result.project.trackConfigs || [];
                        
                        if (!project.trackConfigs || project.trackConfigs.length === 0) {
                            const maxIdx = project.tracks.reduce((max, t) => Math.max(max, t.trackIndex), 2);
                            project.trackConfigs = [];
                            for (let i = 0; i <= maxIdx; i++) {
                                project.trackConfigs.push({ name: `Track ${i + 1}` });
                            }
                        }
                        
                        rebuildTracksUI();
                        localStorage.setItem(`htmlvr_unsaved_project_${currentProject}`, JSON.stringify(project));
                        
                        // Reload compositions sidebar
                        await loadCompositions();
                        
                        // Hide Undo button
                        btnUndoProject.style.display = 'none';
                        
                        showToast("Workspace restored!");
                    } else {
                        alert("Failed to undo reset: " + result.error);
                    }
                } catch (err) {
                    alert("Error performing undo: " + err.message);
                }
            });
        }

        // Asset upload zone click & drag-and-drop listeners
        if (uploadZone && fileUploader) {
            uploadZone.addEventListener('click', () => {
                fileUploader.click();
            });

            fileUploader.addEventListener('change', (e) => {
                handleUploadedFiles(e.target.files);
            });

            uploadZone.addEventListener('dragover', (e) => {
                e.preventDefault();
                uploadZone.classList.add('drag-over');
            });

            uploadZone.addEventListener('dragleave', () => {
                uploadZone.classList.remove('drag-over');
            });

            uploadZone.addEventListener('drop', (e) => {
                e.preventDefault();
                uploadZone.classList.remove('drag-over');
                handleUploadedFiles(e.dataTransfer.files);
            });
        }

        async function handleUploadedFiles(files) {
            for (let file of files) {
                const reader = new FileReader();
                reader.onload = async (evt) => {
                    const base64Data = evt.target.result.split(',')[1];
                    try {
                        const response = await fetch('/api/upload', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({
                                name: file.name,
                                data: base64Data,
                                project: currentProject
                            })
                        });
                        const result = await response.json();
                        if (result.success) {
                            console.log("Uploaded successfully:", file.name);
                            loadCompositions();
                        } else {
                            alert("Failed to upload: " + result.error);
                        }
                    } catch(err) {
                        alert("Upload error: " + err.message);
                    }
                };
                reader.readAsDataURL(file);
            }
        }

        if (btnRenderCancel) {
            btnRenderCancel.addEventListener('click', () => {
                if (renderAbortController) {
                    renderAbortController.abort();
                    renderAbortController = null;
                }
                renderModal.style.display = 'none';
            });
        }

        btnRender.addEventListener('click', async () => {
            if (project.tracks.length === 0) {
                alert("Please add at least one composition track to the timeline first.");
                return;
            }

            const resStr = selectResolution.value;
            const [w, h] = resStr.split('x').map(x => parseInt(x));
            
            settings.width = w;
            settings.height = h;

            // Calculate actual project duration (up to the end of the last clip)
            let maxDuration = 0;
            project.tracks.forEach(t => {
                const end = t.start + t.duration;
                if (end > maxDuration) maxDuration = end;
            });
            settings.duration = Math.max(1, maxDuration);
            settings.renderMode = 'webcodecs';

            // Reset render modal UI
            const renderAudioStatsPanel = document.getElementById('render-audio-stats-panel');
            const btnRenderDownload = document.getElementById('btn-render-download');
            const renderModalTitle = document.getElementById('render-modal-title');
            const renderSubHint = document.getElementById('render-sub-hint');

            if (renderAudioStatsPanel) renderAudioStatsPanel.style.display = 'none';
            if (btnRenderDownload) btnRenderDownload.style.display = 'none';
            if (renderModalTitle) renderModalTitle.innerText = "Compiling Media Output";
            if (renderSubHint) renderSubHint.innerText = "Rendering frames sequentially via Puppeteer & FFmpeg...";
            if (btnRenderCancel) btnRenderCancel.innerText = "STOP RENDER";

            renderModal.style.display = 'flex';
            renderStatus.innerText = "Initializing render...";
            renderProgressFill.style.width = '0%';

            renderAbortController = new AbortController();
            const signal = renderAbortController.signal;

            const abortListener = () => {
                if (previewIframe && previewIframe.contentWindow) {
                    previewIframe.contentWindow.postMessage({ type: 'abort-in-browser-render' }, '*');
                }
            };
            signal.addEventListener('abort', abortListener);

            if (previewIframe && previewIframe.contentWindow) {
                previewIframe.contentWindow.postMessage({
                    type: 'start-in-browser-render',
                    settings: settings,
                    renderMode: 'webcodecs'
                }, '*');
            }
        });

        let pendingDownloadUrl = null;
        let pendingDownloadFilename = null;

        const btnRenderDownload = document.getElementById('btn-render-download');
        if (btnRenderDownload) {
            btnRenderDownload.addEventListener('click', () => {
                if (pendingDownloadUrl) {
                    const link = document.createElement('a');
                    link.href = pendingDownloadUrl;
                    link.download = pendingDownloadFilename || `render_${Date.now()}.mp4`;
                    document.body.appendChild(link);
                    link.click();
                    link.remove();
                    showToast("Video download started!");
                }
            });
        }

        // Listen for messages from preview iframe regarding in-browser rendering
        window.addEventListener('message', async (e) => {
            if (!e.data) return;
            if (e.data.type === 'render-progress') {
                renderProgressFill.style.width = `${e.data.progress}%`;
                renderStatus.innerText = `Rendering: ${e.data.progress}% (Frame ${e.data.frame}/${e.data.total})`;
            } else if (e.data.type === 'render-success') {
                renderProgressFill.style.width = '100%';
                renderStatus.innerText = "Render Success! Video ready.";
                if (renderAbortController) {
                    renderAbortController = null;
                }
                
                const renderAudioStatsPanel = document.getElementById('render-audio-stats-panel');
                const btnRenderDownload = document.getElementById('btn-render-download');
                const renderModalTitle = document.getElementById('render-modal-title');

                if (renderModalTitle) renderModalTitle.innerText = "Render Complete!";
                if (btnRenderCancel) btnRenderCancel.innerText = "CLOSE";

                pendingDownloadUrl = e.data.url;
                pendingDownloadFilename = e.data.url ? e.data.url.split('/').pop() : `render_${Date.now()}.mp4`;
                if (btnRenderDownload) btnRenderDownload.style.display = 'inline-block';

                let stats = e.data.audioStats;
                if (!stats) {
                    try {
                        const previewIframe = document.getElementById('preview-iframe');
                        if (previewIframe && previewIframe.contentWindow && typeof previewIframe.contentWindow.renderAudioOffline === 'function') {
                            let maxDuration = 0;
                            project.tracks.forEach(t => {
                                const end = t.start + t.duration;
                                if (end > maxDuration) maxDuration = end;
                            });
                            const d = Math.max(1, maxDuration);
                            const wavBuf = await previewIframe.contentWindow.renderAudioOffline(d, null, null, null, true);
                            if (wavBuf && wavBuf.audioStats) {
                                stats = wavBuf.audioStats;
                            }
                        }
                    } catch(err) {
                        console.warn("Could not probe audio stats on render completion:", err);
                    }
                }

                if (stats && renderAudioStatsPanel) {
                    document.getElementById('render-stat-peak').innerText = `${stats.peakDb} dBFS`;
                    document.getElementById('render-stat-integrated').innerText = `${stats.integratedLufs} LUFS`;
                    document.getElementById('render-stat-lra').innerText = `${stats.lra} LU`;
                    document.getElementById('render-stat-quiet').innerText = `${stats.quietLufs} LUFS`;
                    document.getElementById('render-stat-mid').innerText = `${stats.midLufs} LUFS`;
                    document.getElementById('render-stat-loud').innerText = `${stats.loudLufs} LUFS`;

                    const badge = document.getElementById('render-peak-badge');
                    if (badge) {
                        if (stats.isClipping) {
                            badge.innerText = 'PEAK HIGH ⚠';
                            badge.style.background = 'rgba(239, 68, 68, 0.2)';
                            badge.style.color = '#f87171';
                            badge.style.borderColor = '#ef4444';
                        } else {
                            badge.innerText = 'PEAK SAFE ✓';
                            badge.style.background = 'rgba(34, 197, 94, 0.2)';
                            badge.style.color = '#4ade80';
                            badge.style.borderColor = '#22c55e';
                        }
                    }
                    renderAudioStatsPanel.style.display = 'block';
                }

                showToast("Render complete! Audio report generated.");
            } else if (e.data.type === 'render-error') {
                if (renderAbortController) {
                    renderAbortController = null;
                }
                alert(`Render error:\n${e.data.message}`);
                renderModal.style.display = 'none';
            }
        });

        // Auto-Master Loudness Normalization Engine
        async function runAutoMasterNormalization(targetLUFS = -16.0, userOffsetDb = 0.0) {
            showToast("Probing project loudness...");
            
            const effectiveTargetLUFS = targetLUFS + userOffsetDb;

            const previewIframe = document.getElementById('preview-iframe');
            if (!previewIframe || !previewIframe.contentWindow || typeof previewIframe.contentWindow.renderAudioOffline !== 'function') {
                showToast("Render engine unavailable for audio probe.", true);
                return null;
            }

            try {
                let maxDuration = 0;
                project.tracks.forEach(t => {
                    const end = t.start + t.duration;
                    if (end > maxDuration) maxDuration = end;
                });
                const d = Math.max(1, maxDuration);

                // Run fast offline probe in browser memory
                const wavBuf = await previewIframe.contentWindow.renderAudioOffline(d, null, null, null, true);
                const stats = wavBuf ? wavBuf.audioStats : null;

                if (!stats || stats.integratedLufs === undefined || stats.integratedLufs <= -90) {
                    showToast("No active audio tracks detected to normalize.");
                    return null;
                }

                const currentLUFS = stats.integratedLufs;
                const deltaDb = effectiveTargetLUFS - currentLUFS;

                console.log(`Auto-Master Probe: Current LUFS = ${currentLUFS}, Target = ${effectiveTargetLUFS}, Delta = ${deltaDb.toFixed(2)} dB`);

                let cTop = project.masterCompressTop !== undefined ? project.masterCompressTop : 1.0;
                let cBot = project.masterCompressBottom !== undefined ? project.masterCompressBottom : 0.0;

                let currentGainRatio = cTop * (1.0 + 4.0 * cBot);
                let currentGainDb = 20 * Math.log10(Math.max(0.01, currentGainRatio));

                let newGainDb = currentGainDb + deltaDb;
                newGainDb = Math.max(-12.0, Math.min(18.0, newGainDb));

                let newGainRatio = Math.pow(10, newGainDb / 20);

                if (newGainRatio <= 1.0) {
                    cBot = 0.0;
                    cTop = Math.max(0.2, newGainRatio);
                } else {
                    cTop = 1.0;
                    cBot = Math.min(1.0, (newGainRatio - 1.0) / 4.0);
                }

                project.masterCompressTop = parseFloat(cTop.toFixed(3));
                project.masterCompressBottom = parseFloat(cBot.toFixed(3));

                if (previewIframe.contentWindow.updateMasterLimiter) {
                    previewIframe.contentWindow.updateMasterLimiter(project.masterCompressTop, project.masterCompressBottom);
                }

                if (typeof updateMasterCompressorVisuals === 'function') {
                    updateMasterCompressorVisuals();
                }
                saveProjectStateDebounced();

                const signedDelta = (deltaDb >= 0 ? '+' : '') + deltaDb.toFixed(1);
                showToast(`⚡ Auto-Master Applied: ${signedDelta} dB → Target ${effectiveTargetLUFS.toFixed(1)} LUFS`);

                return { currentLUFS, newLUFS: effectiveTargetLUFS, deltaDb };
            } catch (err) {
                console.error("Auto-Master normalization failed:", err);
                showToast("Auto-Master error: " + err.message, true);
                return null;
            }
        }

        const btnMasterAutoLevel = document.getElementById('btn-master-auto-level');
        if (btnMasterAutoLevel) {
            btnMasterAutoLevel.addEventListener('click', () => {
                const targetSelect = document.getElementById('render-target-standard');
                const offsetSlider = document.getElementById('render-lufs-offset');
                const targetLufs = targetSelect ? parseFloat(targetSelect.value) : -16.0;
                const offsetDb = offsetSlider ? parseFloat(offsetSlider.value) : 0.0;
                runAutoMasterNormalization(targetLufs, offsetDb);
            });
        }

        const renderTargetStandard = document.getElementById('render-target-standard');
        const renderLufsOffset = document.getElementById('render-lufs-offset');
        const renderLufsOffsetVal = document.getElementById('render-lufs-offset-val');
        const renderTargetLufsVal = document.getElementById('render-target-lufs-val');
        const btnApplyAutoMaster = document.getElementById('btn-apply-auto-master');

        function updateTargetLufsLabel() {
            const std = renderTargetStandard ? parseFloat(renderTargetStandard.value) : -16.0;
            const off = renderLufsOffset ? parseFloat(renderLufsOffset.value) : 0.0;
            const effective = (std + off).toFixed(1);
            if (renderTargetLufsVal) renderTargetLufsVal.innerText = `Target: ${effective} LUFS`;
            if (renderLufsOffsetVal) renderLufsOffsetVal.innerText = `${off >= 0 ? '+' : ''}${off.toFixed(1)} dB`;
        }

        if (renderTargetStandard) renderTargetStandard.addEventListener('change', updateTargetLufsLabel);
        if (renderLufsOffset) renderLufsOffset.addEventListener('input', updateTargetLufsLabel);

        if (btnApplyAutoMaster) {
            btnApplyAutoMaster.addEventListener('click', async () => {
                const std = renderTargetStandard ? parseFloat(renderTargetStandard.value) : -16.0;
                const off = renderLufsOffset ? parseFloat(renderLufsOffset.value) : 0.0;
                const result = await runAutoMasterNormalization(std, off);
                if (result) {
                    showToast("Re-probing audio after normalization...");
                    const previewIframe = document.getElementById('preview-iframe');
                    if (previewIframe && previewIframe.contentWindow && typeof previewIframe.contentWindow.renderAudioOffline === 'function') {
                        let maxDuration = 0;
                        project.tracks.forEach(t => {
                            const end = t.start + t.duration;
                            if (end > maxDuration) maxDuration = end;
                        });
                        const d = Math.max(1, maxDuration);
                        const wavBuf = await previewIframe.contentWindow.renderAudioOffline(d, null, null, null, true);
                        if (wavBuf && wavBuf.audioStats) {
                            const stats = wavBuf.audioStats;
                            document.getElementById('render-stat-peak').innerText = `${stats.peakDb} dBFS`;
                            document.getElementById('render-stat-integrated').innerText = `${stats.integratedLufs} LUFS`;
                            document.getElementById('render-stat-lra').innerText = `${stats.lra} LU`;
                            document.getElementById('render-stat-quiet').innerText = `${stats.quietLufs} LUFS`;
                            document.getElementById('render-stat-mid').innerText = `${stats.midLufs} LUFS`;
                            document.getElementById('render-stat-loud').innerText = `${stats.loudLufs} LUFS`;

                            const badge = document.getElementById('render-peak-badge');
                            if (badge) {
                                if (stats.isClipping) {
                                    badge.innerText = 'PEAK HIGH ⚠';
                                    badge.style.background = 'rgba(239, 68, 68, 0.2)';
                                    badge.style.color = '#f87171';
                                    badge.style.borderColor = '#ef4444';
                                } else {
                                    badge.innerText = 'PEAK SAFE ✓';
                                    badge.style.background = 'rgba(34, 197, 94, 0.2)';
                                    badge.style.color = '#4ade80';
                                    badge.style.borderColor = '#22c55e';
                                }
                            }
                        }
                    }
                }
            });
        }

        // Vertical resizer (sidebar width) dragging logic
        const resizerV = document.getElementById('resizer-v');
        const mainContent = document.getElementById('main-content');
        if (resizerV && mainContent) {
            resizerV.addEventListener('mousedown', (e) => {
                e.preventDefault();
                document.body.classList.add('dragging');
                document.addEventListener('mousemove', onMouseMoveV);
                document.addEventListener('mouseup', onMouseUpV);
            });

            function onMouseMoveV(e) {
                const newWidth = Math.max(150, Math.min(600, e.clientX));
                mainContent.style.setProperty('--sidebar-width', `${newWidth}px`);
            }

            function onMouseUpV() {
                document.body.classList.remove('dragging');
                document.removeEventListener('mousemove', onMouseMoveV);
                document.removeEventListener('mouseup', onMouseUpV);
            }
        }

        // Horizontal resizer (timeline height) dragging logic
        const resizerH = document.getElementById('resizer-h');
        const editorLayout = document.getElementById('editor-layout');
        if (resizerH && editorLayout) {
            resizerH.addEventListener('mousedown', (e) => {
                e.preventDefault();
                document.body.classList.add('dragging');
                document.addEventListener('mousemove', onMouseMoveH);
                document.addEventListener('mouseup', onMouseUpH);
            });

            function onMouseMoveH(e) {
                const newHeight = Math.max(100, Math.min(600, window.innerHeight - e.clientY));
                editorLayout.style.setProperty('--timeline-height', `${newHeight}px`);
            }

            function onMouseUpH() {
                document.body.classList.remove('dragging');
                document.removeEventListener('mousemove', onMouseMoveH);
                document.removeEventListener('mouseup', onMouseUpH);
            }
        }

        // Comment modal action handlers
        if (btnCommentSave) {
            btnCommentSave.addEventListener('click', () => {
                const text = commentText.value.trim();
                if (!text) {
                    alert("Please enter comment text.");
                    return;
                }

                if (!project.markers) project.markers = [];

                if (activeCommentIndex >= 0) {
                    project.markers[activeCommentIndex].text = text;
                } else {
                    project.markers.push({
                        time: activeCommentTime,
                        text: text
                    });
                    project.markers.sort((a, b) => a.time - b.time);
                }

                closeCommentModal();
                updateProjectFromTimeline();
                renderMarkers();
            });
        }

        if (commentText) {
            commentText.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    btnCommentSave.click();
                }
            });
        }

        if (btnCommentCancel) {
            btnCommentCancel.addEventListener('click', () => {
                closeCommentModal();
            });
        }

        if (btnCommentDelete) {
            btnCommentDelete.addEventListener('click', () => {
                if (activeCommentIndex >= 0) {
                    project.markers.splice(activeCommentIndex, 1);
                    closeCommentModal();
                    updateProjectFromTimeline();
                    renderMarkers();
                }
            });
        }

        // Add Marker trigger via double-click on ruler
        tracksContainer.addEventListener('dblclick', (e) => {
            const rect = tracksContainer.getBoundingClientRect();
            const clickY = e.clientY - rect.top;
            if (clickY > 30) return; // Only trigger if double click is in the ruler height

            if (e.target.closest('.timeline-marker')) return;
            e.preventDefault();
            const x = e.clientX - rect.left + tracksContainer.scrollLeft - TIMELINE_OFFSET;
            const time = Math.max(0, x / PX_PER_SECOND);
            openCommentModal(null, time);
        });

        // Play/pause on click/tap on the viewport overlay (monitor)
        const overlay = document.getElementById('viewport-overlay');
        if (overlay) {
            overlay.addEventListener('click', (e) => {
                if (viewportActiveOutline && viewportActiveOutline.style.display !== 'none') {
                    return;
                }
                togglePlay();
            });
        }

        // Show Keyboard Shortcuts modal
        const btnShortcuts = document.getElementById('btn-shortcuts');
        const btnShortcutsClose = document.getElementById('btn-shortcuts-close');
        const shortcutsModal = document.getElementById('shortcuts-modal');
        if (btnShortcuts && shortcutsModal) {
            btnShortcuts.addEventListener('click', () => {
                shortcutsModal.style.display = 'flex';
            });
        }
        if (btnShortcutsClose && shortcutsModal) {
            btnShortcutsClose.addEventListener('click', () => {
                shortcutsModal.style.display = 'none';
            });
        }
        if (shortcutsModal) {
            shortcutsModal.addEventListener('click', (e) => {
                if (e.target === shortcutsModal) {
                    shortcutsModal.style.display = 'none';
                }
            });
        }
    }

    async function pollServerState() {
        // Skip polling if the user is interacting with the timeline or editing a comment
        const isUserInteracting = isPlaying || 
                                  isDraggingPlayhead || 
                                  (commentModal && commentModal.style.display === 'flex') ||
                                  document.querySelector('.timeline-block.active') !== null || 
                                  document.body.classList.contains('dragging');
        
        if (isUserInteracting) {
            return;
        }

        try {
            const res = await fetch(`/api/project/state?project=${encodeURIComponent(currentProject)}`);
            if (!res.ok) return;
            const serverProj = await res.json();
            
            // Compare stringified tracks, markers, and trackConfigs to see if they changed
            const serverStateStr = JSON.stringify({
                tracks: serverProj.tracks || [],
                markers: serverProj.markers || [],
                trackConfigs: serverProj.trackConfigs || [],
                masterCompressTop: serverProj.masterCompressTop ?? 1.0,
                masterCompressBottom: serverProj.masterCompressBottom ?? 0.0
            });

            // Compare local project state
            const localStateStr = JSON.stringify({
                tracks: project.tracks || [],
                markers: project.markers || [],
                trackConfigs: project.trackConfigs || [],
                masterCompressTop: project.masterCompressTop ?? 1.0,
                masterCompressBottom: project.masterCompressBottom ?? 0.0
            });

            if (serverStateStr !== localStateStr && serverStateStr !== lastFetchedStateStr) {
                lastFetchedStateStr = serverStateStr;
                
                project.tracks = serverProj.tracks || [];
                project.markers = serverProj.markers || [];
                project.trackConfigs = serverProj.trackConfigs || [];
                project.masterCompressTop = serverProj.masterCompressTop ?? 1.0;
                project.masterCompressBottom = serverProj.masterCompressBottom ?? 0.0;
                
                if (!project.trackConfigs || project.trackConfigs.length === 0) {
                    const maxIdx = project.tracks.reduce((max, t) => Math.max(max, t.trackIndex), 2);
                    project.trackConfigs = [];
                    for (let i = 0; i <= maxIdx; i++) {
                        project.trackConfigs.push({ name: `Track ${i + 1}` });
                    }
                }
                
                rebuildTracksUI();
                localStorage.setItem(`htmlvr_unsaved_project_${currentProject}`, JSON.stringify(project));
                console.log("Timeline auto-synced with server updates.");
            }
        } catch (e) {
            console.warn("Auto-sync fetch failed:", e);
        }
    }

    // Startup Initialization
    function init() {
        // Restore Master VU Meter panel state and bind toggle button click
        const masterMeterPanel = document.getElementById('master-meter-panel');
        const btnToggleMasterMeter = document.getElementById('btn-toggle-master-meter');
        if (masterMeterPanel && btnToggleMasterMeter) {
            const isCollapsed = localStorage.getItem('htmlvr_master_meter_collapsed') !== 'false';
            if (isCollapsed) {
                masterMeterPanel.classList.add('collapsed');
                btnToggleMasterMeter.innerText = '▸';
            } else {
                masterMeterPanel.classList.remove('collapsed');
                btnToggleMasterMeter.innerText = '◂';
            }
            
            btnToggleMasterMeter.addEventListener('click', () => {
                const nowCollapsed = masterMeterPanel.classList.toggle('collapsed');
                localStorage.setItem('htmlvr_master_meter_collapsed', nowCollapsed);
                btnToggleMasterMeter.innerText = nowCollapsed ? '▸' : '◂';
            });

            const peaksText = document.getElementById('master-meter-peaks');
            if (peaksText) {
                peaksText.addEventListener('click', () => {
                    maxPeakL = 0.0;
                    maxPeakR = 0.0;
                    peaksText.innerText = "L:-inf R:-inf";
                });
            }
        }

        // Set active project badge text
        const badge = document.getElementById('project-badge');
        if (badge) {
            badge.innerText = currentProject;
        }

        // Show/hide parent back button
        const btnBackParent = document.getElementById('btn-back-parent');
        if (btnBackParent) {
            const parts = currentProject.split('/');
            if (parts.length > 1) {
                btnBackParent.style.display = 'inline-flex';
                btnBackParent.addEventListener('click', () => {
                    const parentProj = parts.slice(0, -1).join('/');
                    window.location.search = `?project=${encodeURIComponent(parentProj)}`;
                });
            } else {
                btnBackParent.style.display = 'none';
            }
        }

        // Auto-load unsaved project from localStorage if exists
        const saved = localStorage.getItem(`htmlvr_unsaved_project_${currentProject}`);
        if (saved) {
            try {
                const loadedProj = JSON.parse(saved);
                if (loadedProj && loadedProj.tracks) {
                    project.tracks = loadedProj.tracks;
                    project.markers = loadedProj.markers || [];
                    project.trackConfigs = loadedProj.trackConfigs || [];
                    project.masterCompressTop = loadedProj.masterCompressTop !== undefined ? loadedProj.masterCompressTop : 1.0;
                    project.masterCompressBottom = loadedProj.masterCompressBottom !== undefined ? loadedProj.masterCompressBottom : 0.0;
                    
                    // Backward compatibility if trackConfigs is missing
                    if (!project.trackConfigs || project.trackConfigs.length === 0) {
                        const maxIdx = project.tracks.reduce((max, t) => Math.max(max, t.trackIndex), 2);
                        project.trackConfigs = [];
                        for (let i = 0; i <= maxIdx; i++) {
                            project.trackConfigs.push({ name: `Track ${i + 1}` });
                        }
                    }
                }
            } catch(e) {
                console.error("Failed to restore unsaved project:", e);
            }
        }
        
        rebuildTracksUI(); // Rebuilds headers, rows, ruler, and renders clips!
        checkAndUpdateSubprojectDurations();
        loadCompositions();
        initEvents();
        seekTo(0.0);
        pushUndoState();
        updatePreviewSource();

        // Check if there is an undo backup on the server
        fetch(`/api/project/has-backup?project=${encodeURIComponent(currentProject)}`)
            .then(res => res.json())
            .then(data => {
                if (btnUndoProject) {
                    btnUndoProject.style.display = data.hasBackup ? 'inline-flex' : 'none';
                }
            })
            .catch(err => console.warn("Failed to check backup state:", err));

        // Start background polling and run initial check
        setInterval(pollServerState, 2000);
        pollServerState();

        initMasterLimiterDragEvents();
        updateMasterCompressorVisuals();

        // Start continuous VU meter and LUFS monitoring loop
        function meterLoop() {
            updateVolumeMeters();
            requestAnimationFrame(meterLoop);
        }
        requestAnimationFrame(meterLoop);
    }

    window.onload = init;

    function updateMasterCompressorVisuals() {
        const hasSelection = document.querySelectorAll('.track-header.selected').length > 0;
        const overlay = document.querySelector('.master-compress-band');
        const handleTop = document.querySelector('.master-compress-handle-top');
        const handleBottom = document.querySelector('.master-compress-handle-bottom');
        
        if (overlay && handleTop && handleBottom) {
            if (hasSelection) {
                overlay.style.display = 'none';
                handleTop.style.display = 'none';
                handleBottom.style.display = 'none';
            } else {
                overlay.style.display = 'block';
                handleTop.style.display = 'block';
                handleBottom.style.display = 'block';
                
                const cTop = project.masterCompressTop ?? 1.0;
                const cBot = project.masterCompressBottom ?? 0.0;
                
                const topPercent = 100 - ampToDbPercent(cTop);
                const bottomPercent = ampToDbPercent(cBot);
                
                handleTop.style.top = `${topPercent}%`;
                handleBottom.style.bottom = `${bottomPercent}%`;
                
                overlay.style.top = `${topPercent}%`;
                overlay.style.height = `${100 - bottomPercent - topPercent}%`;
            }
        }
    }
    window.updateMasterCompressorVisuals = updateMasterCompressorVisuals;

    function propagateMasterLimiterToPreview() {
        if (previewIframe && previewIframe.contentWindow) {
            try {
                if (typeof previewIframe.contentWindow.updateMasterLimiter === 'function') {
                    previewIframe.contentWindow.updateMasterLimiter(
                        project.masterCompressTop ?? 1.0, 
                        project.masterCompressBottom ?? 0.0
                    );
                }
            } catch (err) {
                console.warn("Failed to propagate master limiter settings:", err);
            }
        }
    }

    function initMasterLimiterDragEvents() {
        const overlay = document.querySelector('.master-compress-band');
        const handleTop = document.querySelector('.master-compress-handle-top');
        const handleBottom = document.querySelector('.master-compress-handle-bottom');
        
        if (!overlay || !handleTop || !handleBottom) return;
        
        function getVUHeight() {
            const container = document.querySelector('.meter-bars-inner-container');
            return container ? container.clientHeight : 100;
        }

        overlay.addEventListener('mousedown', (e) => {
            e.preventDefault();
            e.stopPropagation();
            const startY = e.clientY;
            const startCTop = project.masterCompressTop ?? 1.0;
            const startCBot = project.masterCompressBottom ?? 0.0;
            
            const startTopPct = ampToDbPercent(startCTop);
            const startBotPct = ampToDbPercent(startCBot);
            const vuHeight = getVUHeight();
            
            let dragTooltip = document.createElement('div');
            dragTooltip.className = 'drag-tooltip';
            dragTooltip.style.position = 'absolute';
            dragTooltip.style.background = 'rgba(15, 23, 42, 0.95)';
            dragTooltip.style.color = '#00f0ff';
            dragTooltip.style.padding = '4px 8px';
            dragTooltip.style.borderRadius = '4px';
            dragTooltip.style.fontSize = '12px';
            dragTooltip.style.fontWeight = 'bold';
            dragTooltip.style.fontFamily = 'sans-serif';
            dragTooltip.style.pointerEvents = 'none';
            dragTooltip.style.zIndex = '9999';
            dragTooltip.style.border = '1px solid rgba(0, 240, 255, 0.3)';
            dragTooltip.style.boxShadow = '0 4px 12px rgba(0, 0, 0, 0.5), 0 0 8px rgba(0, 240, 255, 0.15)';
            document.body.appendChild(dragTooltip);
            
            function onMove(ev) {
                const diffY = ev.clientY - startY;
                const diffPct = (diffY / vuHeight) * 100;
                const shiftPct = -diffPct; // Moving up increases percent
                
                let newTopPct = startTopPct + shiftPct;
                let newBotPct = startBotPct + shiftPct;
                
                // Clamp within bounds
                if (newTopPct > 100) {
                    const over = newTopPct - 100;
                    newTopPct = 100;
                    newBotPct -= over;
                }
                if (newBotPct < 0) {
                    const under = -newBotPct;
                    newBotPct = 0;
                    newTopPct += under;
                }
                
                newTopPct = Math.max(10, Math.min(100, newTopPct));
                newBotPct = Math.max(0, Math.min(80, newBotPct));
                
                if (newTopPct < newBotPct + 10) {
                    newTopPct = newBotPct + 10;
                }
                
                const newCTop = parseFloat(dbPercentToAmp(newTopPct).toFixed(3));
                const newCBot = parseFloat(dbPercentToAmp(newBotPct).toFixed(3));
                
                project.masterCompressTop = newCTop;
                project.masterCompressBottom = newCBot;
                
                updateMasterCompressorVisuals();
                propagateMasterLimiterToPreview();
                
                const gain = newCTop * (1.0 + 4.0 * newCBot);
                let text = "";
                if (gain <= 0.0001) {
                    text = "Master: -inf dB";
                } else {
                    const dBVal = 20 * Math.log10(gain);
                    text = `Master: ${dBVal > 0.05 ? '+' : ''}${dBVal.toFixed(1)} dB`;
                }
                dragTooltip.innerText = text;
                dragTooltip.style.left = `${ev.clientX + 15}px`;
                dragTooltip.style.top = `${ev.clientY - 25}px`;
            }
            
            function onUp() {
                document.removeEventListener('mousemove', onMove);
                document.removeEventListener('mouseup', onUp);
                if (dragTooltip) dragTooltip.remove();
                
                pushUndoState();
                localStorage.setItem(`htmlvr_unsaved_project_${currentProject}`, JSON.stringify(project));
                saveProjectStateToServerDebounced();
            }
            
            document.addEventListener('mousemove', onMove);
            document.addEventListener('mouseup', onUp);
        });

        handleTop.addEventListener('mousedown', (e) => {
            e.preventDefault();
            e.stopPropagation();
            const startY = e.clientY;
            const startCTop = project.masterCompressTop ?? 1.0;
            const startTopPct = ampToDbPercent(startCTop);
            const vuHeight = getVUHeight();
            
            let dragTooltip = document.createElement('div');
            dragTooltip.className = 'drag-tooltip';
            dragTooltip.style.position = 'absolute';
            dragTooltip.style.background = 'rgba(15, 23, 42, 0.95)';
            dragTooltip.style.color = '#00f0ff';
            dragTooltip.style.padding = '4px 8px';
            dragTooltip.style.borderRadius = '4px';
            dragTooltip.style.fontSize = '12px';
            dragTooltip.style.fontWeight = 'bold';
            dragTooltip.style.fontFamily = 'sans-serif';
            dragTooltip.style.pointerEvents = 'none';
            dragTooltip.style.zIndex = '9999';
            dragTooltip.style.border = '1px solid rgba(0, 240, 255, 0.3)';
            dragTooltip.style.boxShadow = '0 4px 12px rgba(0, 0, 0, 0.5), 0 0 8px rgba(0, 240, 255, 0.15)';
            document.body.appendChild(dragTooltip);
            
            function onMove(ev) {
                const diffY = ev.clientY - startY;
                const diffPct = (diffY / vuHeight) * 100;
                let newTopPct = startTopPct - diffPct;
                
                const minPct = ampToDbPercent(project.masterCompressBottom ?? 0.0) + 10;
                newTopPct = Math.max(minPct, Math.min(100, newTopPct));
                
                const newCTop = parseFloat(dbPercentToAmp(newTopPct).toFixed(3));
                project.masterCompressTop = newCTop;
                
                updateMasterCompressorVisuals();
                propagateMasterLimiterToPreview();
                
                const cBot = project.masterCompressBottom ?? 0.0;
                const gain = newCTop * (1.0 + 4.0 * cBot);
                let text = "";
                if (gain <= 0.0001) {
                    text = "Master: -inf dB";
                } else {
                    const dBVal = 20 * Math.log10(gain);
                    text = `Master: ${dBVal > 0.05 ? '+' : ''}${dBVal.toFixed(1)} dB`;
                }
                dragTooltip.innerText = text;
                dragTooltip.style.left = `${ev.clientX + 15}px`;
                dragTooltip.style.top = `${ev.clientY - 25}px`;
            }
            
            function onUp() {
                document.removeEventListener('mousemove', onMove);
                document.removeEventListener('mouseup', onUp);
                if (dragTooltip) dragTooltip.remove();
                
                pushUndoState();
                localStorage.setItem(`htmlvr_unsaved_project_${currentProject}`, JSON.stringify(project));
                saveProjectStateToServerDebounced();
            }
            
            document.addEventListener('mousemove', onMove);
            document.addEventListener('mouseup', onUp);
        });

        handleBottom.addEventListener('mousedown', (e) => {
            e.preventDefault();
            e.stopPropagation();
            const startY = e.clientY;
            const startCBot = project.masterCompressBottom ?? 0.0;
            const startBotPct = ampToDbPercent(startCBot);
            const vuHeight = getVUHeight();
            
            let dragTooltip = document.createElement('div');
            dragTooltip.className = 'drag-tooltip';
            dragTooltip.style.position = 'absolute';
            dragTooltip.style.background = 'rgba(15, 23, 42, 0.95)';
            dragTooltip.style.color = '#00f0ff';
            dragTooltip.style.padding = '4px 8px';
            dragTooltip.style.borderRadius = '4px';
            dragTooltip.style.fontSize = '12px';
            dragTooltip.style.fontWeight = 'bold';
            dragTooltip.style.fontFamily = 'sans-serif';
            dragTooltip.style.pointerEvents = 'none';
            dragTooltip.style.zIndex = '9999';
            dragTooltip.style.border = '1px solid rgba(0, 240, 255, 0.3)';
            dragTooltip.style.boxShadow = '0 4px 12px rgba(0, 0, 0, 0.5), 0 0 8px rgba(0, 240, 255, 0.15)';
            document.body.appendChild(dragTooltip);
            
            function onMove(ev) {
                const diffY = ev.clientY - startY;
                const diffPct = (diffY / vuHeight) * 100;
                let newBotPct = startBotPct - diffPct;
                
                const maxPct = ampToDbPercent(project.masterCompressTop ?? 1.0) - 10;
                newBotPct = Math.max(0, Math.min(Math.min(80, maxPct), newBotPct));
                
                const newCBot = parseFloat(dbPercentToAmp(newBotPct).toFixed(3));
                project.masterCompressBottom = newCBot;
                
                updateMasterCompressorVisuals();
                propagateMasterLimiterToPreview();
                
                const cTop = project.masterCompressTop ?? 1.0;
                const gain = cTop * (1.0 + 4.0 * newCBot);
                let text = "";
                if (gain <= 0.0001) {
                    text = "Master: -inf dB";
                } else {
                    const dBVal = 20 * Math.log10(gain);
                    text = `Master: ${dBVal > 0.05 ? '+' : ''}${dBVal.toFixed(1)} dB`;
                }
                dragTooltip.innerText = text;
                dragTooltip.style.left = `${ev.clientX + 15}px`;
                dragTooltip.style.top = `${ev.clientY - 25}px`;
            }
            
            // Mouseup callback
            function onUp() {
                document.removeEventListener('mousemove', onMove);
                document.removeEventListener('mouseup', onUp);
                if (dragTooltip) dragTooltip.remove();
                
                pushUndoState();
                localStorage.setItem(`htmlvr_unsaved_project_${currentProject}`, JSON.stringify(project));
                saveProjectStateToServerDebounced();
            }
            
            document.addEventListener('mousemove', onMove);
            document.addEventListener('mouseup', onUp);
        });
    }

    function syncActiveClipToIframe() {
        const activeBlock = document.querySelector('.timeline-block.active');
        const sidebarDeleteContainer = document.getElementById('sidebar-delete-container');
        
        // Sync properties panel display in sidebar
        if (activeBlock) {
            if (sidebarDeleteContainer) sidebarDeleteContainer.style.display = 'flex';
            const isAudio = activeBlock.dataset.src.toLowerCase().endsWith('.mp3') || 
                            activeBlock.dataset.src.toLowerCase().endsWith('.wav') || 
                            activeBlock.dataset.src.toLowerCase().endsWith('.ogg');
            if (isAudio) {
                if (clipPropertiesPanel) clipPropertiesPanel.style.display = 'none';
                if (assetsContainer) assetsContainer.style.display = 'flex';
            } else {
                if (clipPropertiesPanel) clipPropertiesPanel.style.display = 'flex';
                if (assetsContainer) assetsContainer.style.display = 'none';
                const scale = parseFloat(activeBlock.dataset.scale) || 1.0;
                const scaleX = parseFloat(activeBlock.dataset.scaleX) || scale;
                const scaleY = parseFloat(activeBlock.dataset.scaleY) || scale;
                const panX = parseFloat(activeBlock.dataset.panX) || 0;
                const panY = parseFloat(activeBlock.dataset.panY) || 0;
                const rotation = parseFloat(activeBlock.dataset.rotation) || 0;
                const opacity = activeBlock.dataset.opacity !== undefined ? parseFloat(activeBlock.dataset.opacity) : 1.0;
                if (propScale) { propScale.value = scale; propScaleVal.innerText = scale.toFixed(2); }
                if (propScaleX) { propScaleX.value = scaleX; if (propScaleXVal) propScaleXVal.innerText = scaleX.toFixed(2); }
                if (propScaleY) { propScaleY.value = scaleY; if (propScaleYVal) propScaleYVal.innerText = scaleY.toFixed(2); }
                if (propPanX) { propPanX.value = panX; propPanXVal.innerText = Math.round(panX); }
                if (propPanY) { propPanY.value = panY; propPanYVal.innerText = Math.round(panY); }
                if (propRotation) {
                    let rotVal = rotation;
                    while (rotVal > 180) rotVal -= 360;
                    while (rotVal < -180) rotVal += 360;
                    propRotation.value = Math.round(rotVal);
                    if (propRotationVal) propRotationVal.innerText = `${Math.round(rotVal)}°`;
                }
                if (propOpacity) {
                    propOpacity.value = opacity;
                    if (propOpacityVal) propOpacityVal.innerText = opacity.toFixed(2);
                }
                const mirror = activeBlock.dataset.mirror === "true";
                if (propMirror) propMirror.checked = mirror;

                // Sync Transitions
                const fadeIn = parseFloat(activeBlock.dataset.fadeIn) || 0;
                const fadeOut = parseFloat(activeBlock.dataset.fadeOut) || 0;
                const transIn = activeBlock.dataset.transitionIn || (fadeIn > 0 ? 'fade' : 'none');
                const transOut = activeBlock.dataset.transitionOut || (fadeOut > 0 ? 'fade' : 'none');
                
                if (propTransInType) propTransInType.value = transIn;
                if (propTransInDuration) {
                    propTransInDuration.value = fadeIn;
                    if (propTransInDurationVal) propTransInDurationVal.innerText = `${fadeIn.toFixed(2)}s`;
                }
                
                if (propTransOutType) propTransOutType.value = transOut;
                if (propTransOutDuration) {
                    propTransOutDuration.value = fadeOut;
                    if (propTransOutDurationVal) propTransOutDurationVal.innerText = `${fadeOut.toFixed(2)}s`;
                }
                
                // Sync Subproject Defaults
                const isSubproj = activeBlock.dataset.src && activeBlock.dataset.src.startsWith('project:');
                if (isSubproj) {
                    if (subprojSettingsBlock) subprojSettingsBlock.style.display = 'block';
                    const subStyle = activeBlock.dataset.subprojDefaultTransition || 'none';
                    const subDur = parseFloat(activeBlock.dataset.subprojTransitionDuration) ?? 0.5;
                    const subOverride = activeBlock.dataset.subprojTransitionOverride || 'empty';
                    
                    if (propSubprojTransType) propSubprojTransType.value = subStyle;
                    if (propSubprojTransDuration) {
                        propSubprojTransDuration.value = subDur;
                        if (propSubprojTransDurationVal) propSubprojTransDurationVal.innerText = `${subDur.toFixed(2)}s`;
                    }
                    if (propSubprojTransOverride) propSubprojTransOverride.value = subOverride;
                } else {
                    if (subprojSettingsBlock) subprojSettingsBlock.style.display = 'none';
                }

                // Sync Animation Block
                if (animSettingsBlock) animSettingsBlock.style.display = 'block';
                
                const clipDur = parseFloat(activeBlock.dataset.duration) || 10;
                let typeVal = 'translate';
                let startVal = 0;
                let endVal = clipDur;
                let dirVal = 90;
                let ampVal = 0;
                let freqVal = 3;
                let pivotXVal = 50;
                let pivotYVal = 50;
                let easingVal = 'linear';
                
                const hasAnim = !!activeBlock.dataset.animateTool;
                if (hasAnim) {
                    try {
                        let parsed = JSON.parse(activeBlock.dataset.animateTool);
                        if (parsed) {
                            if (!Array.isArray(parsed)) {
                                parsed = [parsed];
                            }
                            const anim = parsed[0];
                            if (anim) {
                                typeVal = anim.type || 'translate';
                                startVal = parseFloat(anim.start_time) || 0;
                                endVal = anim.end_time !== undefined ? parseFloat(anim.end_time) : clipDur;
                                dirVal = parseFloat(anim.direction_angle) || 0;
                                ampVal = parseFloat(anim.amplitude) || 0;
                                freqVal = parseFloat(anim.periodicity) || 1;
                                pivotXVal = parseFloat(anim.pivot ? anim.pivot[0] : 50);
                                pivotYVal = parseFloat(anim.pivot ? anim.pivot[1] : 50);
                                easingVal = anim.easing || 'linear';
                            }
                        }
                    } catch (err) {
                        console.warn("Failed to sync animation settings on select:", err);
                    }
                }
                
                if (propAnimType) propAnimType.value = typeVal;
                if (propAnimEasing) propAnimEasing.value = easingVal;
                if (propAnimStart) {
                    propAnimStart.max = clipDur;
                    propAnimStart.value = startVal;
                }
                if (propAnimEnd) {
                    propAnimEnd.max = clipDur;
                    propAnimEnd.value = endVal;
                }
                if (propAnimDir) propAnimDir.value = dirVal;
                if (propAnimAmp) {
                    if (typeVal === 'rotate') {
                        propAnimAmp.min = 0;
                        propAnimAmp.max = 1800;
                        propAnimAmp.step = 1;
                    } else if (typeVal === 'scale') {
                        propAnimAmp.min = 0;
                        propAnimAmp.max = 25;
                        propAnimAmp.step = 0.1;
                    } else if (typeVal === 'shake') {
                        propAnimAmp.min = 0;
                        propAnimAmp.max = 1000;
                        propAnimAmp.step = 1;
                    } else {
                        propAnimAmp.min = 0;
                        propAnimAmp.max = 5000;
                        propAnimAmp.step = 1;
                    }
                    propAnimAmp.value = ampVal;
                }
                if (propAnimFreq) propAnimFreq.value = freqVal;
                if (propAnimPivotX) propAnimPivotX.value = pivotXVal;
                if (propAnimPivotY) propAnimPivotY.value = pivotYVal;

                const propAnimDirRow = document.getElementById('prop-anim-dir-row');
                const propAnimAmpLabel = document.getElementById('prop-anim-amp-label');
                if (typeVal === 'rotate') {
                    if (propAnimDirRow) propAnimDirRow.style.display = 'none';
                    if (propAnimAmpLabel) propAnimAmpLabel.innerText = 'Amplitude (Deg)';
                    if (propAnimAmpVal) propAnimAmpVal.innerText = `${ampVal}°`;
                } else if (typeVal === 'scale') {
                    if (propAnimDirRow) propAnimDirRow.style.display = 'none';
                    if (propAnimAmpLabel) propAnimAmpLabel.innerText = 'Amplitude (Scale Change)';
                    if (propAnimAmpVal) propAnimAmpVal.innerText = ampVal;
                } else if (typeVal === 'shake') {
                    if (propAnimDirRow) propAnimDirRow.style.display = 'none';
                    if (propAnimAmpLabel) propAnimAmpLabel.innerText = 'Amplitude (px)';
                    if (propAnimAmpVal) propAnimAmpVal.innerText = `${ampVal}px`;
                } else {
                    if (propAnimDirRow) propAnimDirRow.style.display = 'block';
                    if (propAnimAmpLabel) propAnimAmpLabel.innerText = 'Amplitude (px)';
                    if (propAnimAmpVal) propAnimAmpVal.innerText = `${ampVal}px`;
                }

                if (propAnimStartVal) propAnimStartVal.innerText = `${startVal.toFixed(2)}s`;
                if (propAnimEndVal) propAnimEndVal.innerText = `${endVal.toFixed(2)}s`;
                if (propAnimDirVal) propAnimDirVal.innerText = `${dirVal}°`;
                if (propAnimFreqVal) propAnimFreqVal.innerText = freqVal;
                if (propAnimPivotXVal) propAnimPivotXVal.innerText = pivotXVal;
                if (propAnimPivotYVal) propAnimPivotYVal.innerText = pivotYVal;
            }
        } else {
            if (clipPropertiesPanel) clipPropertiesPanel.style.display = 'none';
            if (assetsContainer) assetsContainer.style.display = 'flex';
            if (sidebarDeleteContainer) sidebarDeleteContainer.style.display = 'none';
        }

        // Update active outline overlay
        updateViewportOutline();

        if (previewIframe && previewIframe.contentWindow) {
            try {
                if (typeof previewIframe.contentWindow.setActiveClip === 'function') {
                    previewIframe.contentWindow.setActiveClip(activeBlock ? activeBlock.dataset.id : null);
                }
            } catch(e) {}
        }
        updateToolbarButtonsState();
    }

    function setViewportOverlayInteractive(interactive) {
        const overlay = document.getElementById('viewport-overlay');
        if (overlay) {
            overlay.style.pointerEvents = interactive ? 'auto' : 'none';
            overlay.style.cursor = interactive ? 'pointer' : 'default';
        }
    }

    function updateViewportOutline() {
        const activeBlock = document.querySelector('.timeline-block.active');
        if (!activeBlock) {
            if (viewportActiveOutline) viewportActiveOutline.style.display = 'none';
            setViewportOverlayInteractive(true);
            return;
        }
        
        const src = activeBlock.dataset.src.toLowerCase();
        const isAudio = src.endsWith('.mp3') || src.endsWith('.wav') || src.endsWith('.ogg');
        if (isAudio) {
            if (viewportActiveOutline) viewportActiveOutline.style.display = 'none';
            setViewportOverlayInteractive(true);
            return;
        }

        // Check if the clip is within the visible time window
        const start = parseFloat(activeBlock.dataset.start);
        const duration = parseFloat(activeBlock.dataset.duration);
        const localTime = playheadTime - start;
        if (localTime < 0 || localTime > duration) {
            if (viewportActiveOutline) viewportActiveOutline.style.display = 'none';
            setViewportOverlayInteractive(true);
            return;
        }

        if (!previewIframe) return;
        const rect = previewIframe.getBoundingClientRect();
        const containerWidth = rect.width;
        const containerHeight = rect.height;
        if (containerWidth === 0 || containerHeight === 0) return;

        let baseWidth = settings.width || 1920;
        let baseHeight = settings.height || 1080;

        try {
            if (previewIframe.contentWindow) {
                const hostDoc = previewIframe.contentDocument || previewIframe.contentWindow.document;
                if (hostDoc) {
                    const compEl = hostDoc.querySelector(`[data-id="${activeBlock.dataset.id}"]`);
                    if (compEl && compEl.dataset.type === 'html') {
                        const childWin = compEl.contentWindow;
                        const childDoc = compEl.contentDocument || childWin.document;
                        if (childDoc) {
                            const childCompEl = childDoc.querySelector('[data-width][data-height]');
                            if (childCompEl) {
                                baseWidth = parseInt(childCompEl.dataset.width) || baseWidth;
                                baseHeight = parseInt(childCompEl.dataset.height) || baseHeight;
                            }
                        }
                    }
                }
            }
        } catch (e) {}

        // src is already declared at top of function.
        const isHtmlClip = !src.match(/\.(mp4|webm|mp3|wav|ogg|png|jpg|jpeg|gif)$/);
        const outlineDesignW = isHtmlClip ? 1920 : (settings.width || 1920);
        const outlineDesignH = isHtmlClip ? 1080 : (settings.height || 1080);

        // viewportScale maps design-space pixels → screen pixels.
        const viewportScale = Math.min(containerWidth / outlineDesignW, containerHeight / outlineDesignH);
        const scale = parseFloat(activeBlock.dataset.scale) || 1.0;
        const scaleX = parseFloat(activeBlock.dataset.scaleX) || scale;
        const scaleY = parseFloat(activeBlock.dataset.scaleY) || scale;
        const panX = parseFloat(activeBlock.dataset.panX) || 0;
        const panY = parseFloat(activeBlock.dataset.panY) || 0;

        const ratio = Math.min(containerWidth / outlineDesignW, containerHeight / outlineDesignH);
        let w = outlineDesignW * ratio * scaleX;
        let h = outlineDesignH * ratio * scaleY;
        let left = containerWidth / 2 + panX * viewportScale;
        let top = containerHeight / 2 + panY * viewportScale;

        const rotation = parseFloat(activeBlock.dataset.rotation) || 0;

        if (viewportActiveOutline) {
            viewportActiveOutline.style.display = 'block';
            viewportActiveOutline.style.width = `${w}px`;
            viewportActiveOutline.style.height = `${h}px`;
            viewportActiveOutline.style.left = `${left}px`;
            viewportActiveOutline.style.top = `${top}px`;
            viewportActiveOutline.style.transform = `translate(-50%, -50%) rotate(${rotation}deg)`;
            if (viewportOutlineLabel) {
                const clipName = activeBlock.dataset.name || "Clip";
                const rotText = rotation !== 0 ? `, Rot: ${Math.round(rotation)}°` : '';
                const scaleXText = scaleX !== scaleY ? `${scaleX.toFixed(2)}x${scaleY.toFixed(2)}` : `${scaleX.toFixed(2)}`;
                viewportOutlineLabel.innerText = `${clipName} (${scaleXText}${rotText}, Offset: ${Math.round(panX)}, ${Math.round(panY)})`;
            }
        }
        setViewportOverlayInteractive(false);
    }

    window.addEventListener('resize', updateViewportOutline);

    let saveStateTimeout = null;
    function saveProjectStateToServerDebounced() {
        if (saveStateTimeout) clearTimeout(saveStateTimeout);
        saveStateTimeout = setTimeout(() => {
            fetch(`/api/project/state?project=${encodeURIComponent(currentProject)}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(project)
            }).then(() => {
                lastFetchedStateStr = JSON.stringify({
                    tracks: project.tracks || [],
                    markers: project.markers || [],
                    trackConfigs: project.trackConfigs || []
                });
            }).catch(err => console.error("Error saving state to server:", err));
        }, 500);
    }

    window.onClipTransformChanged = function(clipId, panX, panY, scale, rotation, scaleX, scaleY, opacity) {
        const block = document.querySelector(`.timeline-block[data-id="${clipId}"]`);
        if (block) {
            block.dataset.panX = panX;
            block.dataset.panY = panY;
            block.dataset.scale = scale;
            
            const sX = scaleX !== undefined ? scaleX : scale;
            const sY = scaleY !== undefined ? scaleY : scale;
            block.dataset.scaleX = sX;
            block.dataset.scaleY = sY;
            
            if (rotation !== undefined) block.dataset.rotation = rotation;
            const op = opacity !== undefined ? opacity : 1.0;
            block.dataset.opacity = op;
            
            const clip = project.tracks.find(t => t.id === clipId);
            if (clip) {
                clip.panX = panX;
                clip.panY = panY;
                clip.scale = scale;
                clip.scaleX = sX;
                clip.scaleY = sY;
                if (rotation !== undefined) clip.rotation = rotation;
                clip.opacity = op;
            }
            
            localStorage.setItem(`htmlvr_unsaved_project_${currentProject}`, JSON.stringify(project));
            saveProjectStateToServerDebounced();
            
            // Sync outline and properties panel if this is the active block
            const activeBlock = document.querySelector('.timeline-block.active');
            if (activeBlock && activeBlock.dataset.id === clipId) {
                if (propScale) { propScale.value = scale; propScaleVal.innerText = scale.toFixed(2); }
                if (propScaleX) { propScaleX.value = sX; if (propScaleXVal) propScaleXVal.innerText = sX.toFixed(2); }
                if (propScaleY) { propScaleY.value = sY; if (propScaleYVal) propScaleYVal.innerText = sY.toFixed(2); }
                if (propPanX) { propPanX.value = panX; propPanXVal.innerText = Math.round(panX); }
                if (propPanY) { propPanY.value = panY; propPanYVal.innerText = Math.round(panY); }
                if (propRotation && rotation !== undefined) {
                    let rotVal = rotation;
                    while (rotVal > 180) rotVal -= 360;
                    while (rotVal < -180) rotVal += 360;
                    propRotation.value = Math.round(rotVal);
                    if (propRotationVal) propRotationVal.innerText = `${Math.round(rotVal)}°`;
                }
                if (propOpacity) {
                    propOpacity.value = op;
                    if (propOpacityVal) propOpacityVal.innerText = op.toFixed(2);
                }
                updateViewportOutline();
            }
        }
    };

    function initUserGestureAudioResume() {
        const resumeAudio = () => {
            if (previewIframe && previewIframe.contentWindow) {
                const iframeCtx = previewIframe.contentWindow.audioCtx;
                if (iframeCtx && iframeCtx.state === 'suspended') {
                    iframeCtx.resume().catch(e => console.warn("Failed to resume iframe audioCtx on user gesture:", e));
                }
            }
        };
        document.addEventListener('mousedown', resumeAudio, { passive: true });
        document.addEventListener('keydown', resumeAudio, { passive: true });
    }
    initUserGestureAudioResume();

})();
