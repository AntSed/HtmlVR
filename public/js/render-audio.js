(function() {
    "use strict";

    // Web Audio API global state references
    window.audioCtx = null;
    window.masterCompressor = null;
    window.masterLimiter = null;
    window.masterAnalyserL = null;
    window.masterAnalyserR = null;
    window.vuSumNode = null;
    window.splitter = null;
    
    window.audioNodesMap = new Map();
    window.trackAnalysers = new Map();
    window.selectedTracksForVU = [];

    // Helper functions for cross-origin parent window security checks
    function isParentAccessible() {
        try {
            return !!(window.parent && window.parent.location && window.parent.location.href);
        } catch (e) {
            return false;
        }
    }

    function isTopAccessible() {
        try {
            return !!(window.top && window.top.location && window.top.location.href);
        } catch (e) {
            return false;
        }
    }

    function initAudioContext() {
        if (window.audioCtx) return;
        try {
            if (isParentAccessible() && window.parent !== window) {
                if (typeof window.parent.initAudioContext === 'function') {
                    window.parent.initAudioContext();
                }
                if (window.parent.audioCtx) {
                    window.audioCtx = window.parent.audioCtx;
                    window.masterCompressor = window.parent.masterCompressor || null;
                    window.masterLimiter = window.parent.masterLimiter || null;
                    window.masterAnalyserL = window.parent.masterAnalyserL || null;
                    window.masterAnalyserR = window.parent.masterAnalyserR || null;
                    window.vuSumNode = window.parent.vuSumNode || null;
                    window.splitter = window.parent.splitter || null;
                    return;
                }
            }

            const AudioContextClass = window.AudioContext || window.webkitAudioContext;
            const audioCtx = new AudioContextClass();
            window.audioCtx = audioCtx;
            
            const masterCompressor = audioCtx.createDynamicsCompressor();
            masterCompressor.attack.setValueAtTime(0.003, audioCtx.currentTime);
            masterCompressor.release.setValueAtTime(0.08, audioCtx.currentTime);
            window.masterCompressor = masterCompressor;
            
            const masterLimiter = audioCtx.createGain();
            window.masterLimiter = masterLimiter;
            
            // Brickwall Lookahead Limiter to guarantee peaks do not exceed -1.0 dBFS
            function createLookaheadLimiter(audioCtx) {
                const bufferSize = 4096;
                const limiterNode = audioCtx.createScriptProcessor(bufferSize, 2, 2);
                
                const sampleRate = audioCtx.sampleRate;
                const lookaheadTime = 0.005; // 5ms lookahead
                const delaySamples = Math.max(1, Math.ceil(lookaheadTime * sampleRate) || 240);
                const releaseTime = 0.08; // 80ms release
                const coeffRelease = 1.0 - Math.exp(-1.0 / (releaseTime * sampleRate));
                const C = 0.89125; // -1.0 dBFS ceiling (approx. 0.89 linear amplitude)
                
                const delayBufL = new Float32Array(delaySamples);
                const delayBufR = new Float32Array(delaySamples);
                let writeIdx = 0;
                let currentGain = 1.0;
                
                limiterNode.onaudioprocess = function(e) {
                    const inputBuffer = e.inputBuffer;
                    const outputBuffer = e.outputBuffer;
                    const len = inputBuffer.length;
                    
                    const inL = inputBuffer.numberOfChannels > 0 ? inputBuffer.getChannelData(0) : new Float32Array(len);
                    const inR = inputBuffer.numberOfChannels > 1 ? inputBuffer.getChannelData(1) : inL;
                    const outL = outputBuffer.numberOfChannels > 0 ? outputBuffer.getChannelData(0) : null;
                    const outR = outputBuffer.numberOfChannels > 1 ? outputBuffer.getChannelData(1) : outL;
                    
                    for (let i = 0; i < len; i++) {
                        const xL = inL[i];
                        const xR = inR[i];
                        
                        // 1. Read delayed sample first
                        const delayedL = delayBufL[writeIdx];
                        const delayedR = delayBufR[writeIdx];
                        
                        // 2. Overwrite with new incoming sample
                        delayBufL[writeIdx] = xL;
                        delayBufR[writeIdx] = xR;
                        
                        // 3. Move pointer
                        writeIdx = (writeIdx + 1) % delaySamples;
                        
                        // 4. Find peak in sliding lookahead window (including delayed sample)
                        let maxVal = Math.max(Math.abs(delayedL), Math.abs(delayedR), 0.0001);
                        for (let j = 0; j < delaySamples; j++) {
                            const absL = Math.abs(delayBufL[j]);
                            const absR = Math.abs(delayBufR[j]);
                            if (absL > maxVal) maxVal = absL;
                            if (absR > maxVal) maxVal = absR;
                        }
                        
                        let targetGain = 1.0;
                        if (maxVal > C) {
                            targetGain = C / maxVal;
                        }
                        
                        if (targetGain < currentGain) {
                            currentGain = targetGain; // Instant drop
                        } else {
                            currentGain += (targetGain - currentGain) * coeffRelease; // Smooth recovery
                        }
                        
                        if (outL) outL[i] = delayedL * currentGain;
                        if (outR) outR[i] = delayedR * currentGain;
                    }
                };
                
                return limiterNode;
            }

            // Bypass the main-thread ScriptProcessor lookahead limiter in real-time preview
            // to completely isolate audio playback threads from main-thread layout thrashing (zooming/scrolling)
            window.masterBrickwallLimiter = null;
            
            const masterVUConnector = audioCtx.createGain();
            masterVUConnector.gain.setValueAtTime(1.0, audioCtx.currentTime);
            window.masterVUConnector = masterVUConnector;
            
            masterCompressor.connect(masterLimiter);
            masterLimiter.connect(masterVUConnector);
            
            // Stereo Splitter and Analysers for Master VU meter
            const vuSumNode = audioCtx.createGain();
            vuSumNode.gain.setValueAtTime(1.0, audioCtx.currentTime);
            window.vuSumNode = vuSumNode;

            const splitter = audioCtx.createChannelSplitter(2);
            window.splitter = splitter;
            
            const masterAnalyserL = audioCtx.createAnalyser();
            masterAnalyserL.fftSize = 256;
            window.masterAnalyserL = masterAnalyserL;
            
            const masterAnalyserR = audioCtx.createAnalyser();
            masterAnalyserR.fftSize = 256;
            window.masterAnalyserR = masterAnalyserR;
            
            vuSumNode.connect(splitter);
            splitter.connect(masterAnalyserL, 0);
            splitter.connect(masterAnalyserR, 1);
            
            masterVUConnector.connect(vuSumNode);
            masterLimiter.connect(audioCtx.destination);
            
            // Apply Master Limiter dynamic settings
            window.updateMasterCompressorAndLimiter();
            
            // Set initial routing
            updateVURouting();
        } catch (e) {
            console.error("Failed to init AudioContext:", e);
        }
    }
    window.initAudioContext = initAudioContext;

    function cleanupAudioContext() {
        if (window.audioNodesMap) {
            window.audioNodesMap.forEach((nodes, el) => {
                try {
                    if (nodes.source) nodes.source.disconnect();
                } catch(e) {}
                try {
                    if (nodes.boostGain) nodes.boostGain.disconnect();
                } catch(e) {}
                try {
                    if (nodes.compressor) nodes.compressor.disconnect();
                } catch(e) {}
                try {
                    if (nodes.postGain) nodes.postGain.disconnect();
                } catch(e) {}
            });
            window.audioNodesMap.clear();
        }

        if (window.audioCtx) {
            window.trackAnalysers.clear();
            window.masterAnalyserL = null;
            window.masterAnalyserR = null;
            try {
                let isNested = false;
                try {
                    if (isParentAccessible() && window.parent && window.parent !== window && window.parent.audioCtx === window.audioCtx) {
                        isNested = true;
                    }
                } catch(e) {}
                if (!isNested && typeof window.audioCtx.close === 'function') {
                    window.audioCtx.close().catch(() => {});
                }
            } catch(e) {}
            window.audioCtx = null;
        }
    }
    window.cleanupAudioContext = cleanupAudioContext;
    window.addEventListener('pagehide', cleanupAudioContext);
    window.addEventListener('beforeunload', cleanupAudioContext);

    function getTrackAnalyser(trackIndex) {
        if (window.trackAnalysers.has(trackIndex)) {
            return window.trackAnalysers.get(trackIndex);
        }
        initAudioContext();
        if (!window.audioCtx) return null;
        try {
            const analyser = window.audioCtx.createAnalyser();
            analyser.fftSize = 256;
            
            let connected = false;
            if (window.subprojectDestinationNode) {
                try {
                    analyser.connect(window.subprojectDestinationNode);
                    connected = true;
                } catch(connectErr) {
                    console.warn("Failed to connect analyser to subprojectDestinationNode:", connectErr);
                }
            }
            
            if (!connected) {
                if (isParentAccessible() && window.parent !== window && window.parent.audioCtx) {
                    try {
                        if (window.parent.masterCompressor) {
                            analyser.connect(window.parent.masterCompressor);
                            connected = true;
                        }
                    } catch(connectErr) {}
                }
            }
            
            if (!connected) {
                try {
                    analyser.connect(window.masterCompressor || window.audioCtx.destination);
                } catch(connectErr) {
                    console.warn("Failed to fallback connect analyser:", connectErr);
                }
            }
            
            window.trackAnalysers.set(trackIndex, analyser);
            updateVURouting();
            return analyser;
        } catch (err) {
            console.error("Failed to create track analyser:", err);
            return null;
        }
    }
    window.getTrackAnalyser = getTrackAnalyser;

    window.reconnectSubprojectAudio = function(parentNode) {
        window.subprojectDestinationNode = parentNode;
        window.trackAnalysers.forEach(analyser => {
            try {
                analyser.disconnect();
            } catch(e) {}
            try {
                analyser.connect(parentNode);
            } catch(e) {
                console.warn("Failed to reconnect subproject analyser node:", e);
                try {
                    analyser.connect(window.masterCompressor || window.audioCtx.destination);
                } catch(err) {}
            }
        });
    };

    function updateVURouting() {
        if (!window.audioCtx || !window.vuSumNode || !window.splitter) return;
        
        const activeSelection = window.selectedTracksForVU || [];
        
        try {
            if (window.masterVUConnector) {
                window.masterVUConnector.disconnect(window.vuSumNode);
            }
        } catch(e) {}
        
        window.trackAnalysers.forEach((analyser) => {
            try {
                analyser.disconnect(window.vuSumNode);
            } catch(e) {}
        });
        
        if (activeSelection.length === 0) {
            try {
                if (window.masterVUConnector) {
                    window.masterVUConnector.connect(window.vuSumNode);
                }
            } catch(e) {}
        } else {
            activeSelection.forEach(idx => {
                const analyser = getTrackAnalyser(idx);
                if (analyser) {
                    try {
                        analyser.connect(window.vuSumNode);
                    } catch(e) {}
                }
            });
        }
    }
    window.updateVURouting = updateVURouting;

    window.setSelectedTracksForVU = function(selectedIndices) {
        window.selectedTracksForVU = selectedIndices;
        updateVURouting();
    };

    window.getTrackLevels = function() {
        const levels = {};
        if (!window.audioCtx) return levels;
        
        window.trackAnalysers.forEach((analyser, trackIndex) => {
            const bufferLength = analyser.frequencyBinCount;
            const dataArray = new Float32Array(bufferLength);
            analyser.getFloatTimeDomainData(dataArray);
            
            let sumSq = 0;
            let peak = 0;
            for (let i = 0; i < bufferLength; i++) {
                const val = dataArray[i];
                const absVal = Math.abs(val);
                if (absVal > peak) peak = absVal;
                sumSq += val * val;
            }
            const rms = Math.sqrt(sumSq / bufferLength);
            levels[trackIndex] = {
                rms: parseFloat(rms.toFixed(4)),
                peak: parseFloat(peak.toFixed(4))
            };
        });
        return levels;
    };

    window.getMasterLevels = function() {
        const result = { l: { rms: 0, peak: 0 }, r: { rms: 0, peak: 0 } };
        if (!window.audioCtx) return result;
        
        if (window.masterAnalyserL) {
            const bufferLength = window.masterAnalyserL.frequencyBinCount;
            const dataArray = new Float32Array(bufferLength);
            window.masterAnalyserL.getFloatTimeDomainData(dataArray);
            let sumSq = 0, peak = 0;
            for (let i = 0; i < bufferLength; i++) {
                const val = dataArray[i];
                const absVal = Math.abs(val);
                if (absVal > peak) peak = absVal;
                sumSq += val * val;
            }
            result.l = {
                rms: parseFloat(Math.sqrt(sumSq / bufferLength).toFixed(4)),
                peak: parseFloat(peak.toFixed(4))
            };
        }
        if (window.masterAnalyserR) {
            const bufferLength = window.masterAnalyserR.frequencyBinCount;
            const dataArray = new Float32Array(bufferLength);
            window.masterAnalyserR.getFloatTimeDomainData(dataArray);
            let sumSq = 0, peak = 0;
            for (let i = 0; i < bufferLength; i++) {
                const val = dataArray[i];
                const absVal = Math.abs(val);
                if (absVal > peak) peak = absVal;
                sumSq += val * val;
            }
            result.r = {
                rms: parseFloat(Math.sqrt(sumSq / bufferLength).toFixed(4)),
                peak: parseFloat(peak.toFixed(4))
            };
        }
        return result;
    };

    function getAutoMakeupGain(thresholdDb, ratioVal, kneeDb = 30) {
        const val = thresholdDb + kneeDb / 2;
        if (val < 0) {
            const makeupDb = -0.5 * val * (1 - 1 / ratioVal);
            return Math.pow(10, makeupDb / 20);
        }
        return 1.0;
    }
    window.getAutoMakeupGain = getAutoMakeupGain;

    function getAudioNodes(el) {
        initAudioContext();
        if (!window.audioCtx) return null;
        if (window.audioNodesMap.has(el)) {
            return window.audioNodesMap.get(el);
        }
        try {
            const isIframe = el.tagName === 'IFRAME';
            let source = null;
            if (!isIframe) {
                source = window.audioCtx.createMediaElementSource(el);
            }
            
            const clipBoostGain = window.audioCtx.createGain();
            const clipCompressor = window.audioCtx.createDynamicsCompressor();
            const clipPostGain = window.audioCtx.createGain();
            
            clipCompressor.threshold.setValueAtTime(-24, window.audioCtx.currentTime);
            clipCompressor.ratio.setValueAtTime(12, window.audioCtx.currentTime);
            clipCompressor.attack.setValueAtTime(0.003, window.audioCtx.currentTime);
            clipCompressor.release.setValueAtTime(0.25, window.audioCtx.currentTime);
            
            clipBoostGain.gain.setValueAtTime(1.0, window.audioCtx.currentTime);
            clipPostGain.gain.setValueAtTime(1.0, window.audioCtx.currentTime);
            
            if (source) {
                source.connect(clipBoostGain);
            }
            clipBoostGain.connect(clipCompressor);
            clipCompressor.connect(clipPostGain);
            
            const trackIndex = parseInt(el.dataset.trackIndex || 0);
            const trackAnalyser = getTrackAnalyser(trackIndex);
            if (trackAnalyser) {
                clipPostGain.connect(trackAnalyser);
            } else {
                clipPostGain.connect(window.masterCompressor);
            }
            
            const nodes = {
                source: source,
                boostGain: clipBoostGain,
                compressor: clipCompressor,
                postGain: clipPostGain,
                lastThreshold: null,
                lastRatio: null,
                lastPostGain: null
            };
            window.audioNodesMap.set(el, nodes);
            return nodes;
        } catch (err) {
            console.warn("Could not create Web Audio route for node:", err);
            return null;
        }
    }
    window.getAudioNodes = getAudioNodes;

    function cleanupElementAudio(el) {
        if (!el) return;
        try {
            if (typeof el.pause === 'function') {
                el.pause();
            }
            el.src = "";
            el.removeAttribute('src');
            el.load();
        } catch(e) {}
        
        if (window.audioNodesMap && window.audioNodesMap.has(el)) {
            const nodes = window.audioNodesMap.get(el);
            if (nodes) {
                try {
                    if (nodes.source) nodes.source.disconnect();
                } catch(e) {}
                try {
                    if (nodes.boostGain) nodes.boostGain.disconnect();
                } catch(e) {}
                try {
                    if (nodes.compressor) nodes.compressor.disconnect();
                } catch(e) {}
                try {
                    if (nodes.postGain) nodes.postGain.disconnect();
                } catch(e) {}
            }
            window.audioNodesMap.delete(el);
        }
    }
    window.cleanupElementAudio = cleanupElementAudio;

    let lastMasterCompressTop = null;
    let lastMasterCompressBottom = null;

    window.updateMasterCompressorAndLimiter = function() {
        if (!window.audioCtx || !window.masterCompressor || !window.masterLimiter || !window.project) return;
        
        const cTop = window.project.masterCompressTop !== undefined ? window.project.masterCompressTop : 1.0;
        const cBot = window.project.masterCompressBottom !== undefined ? window.project.masterCompressBottom : 0.0;
        
        if (cTop === lastMasterCompressTop && cBot === lastMasterCompressBottom) return;
        lastMasterCompressTop = cTop;
        lastMasterCompressBottom = cBot;
        
        const compAmount = Math.max(0, Math.min(0.9, (1.0 - cTop) + cBot));
        const thresholdVal = -50 * compAmount;
        const ratioVal = 1 + 19 * compAmount;
        
        const targetGain = cTop * (1.0 + 4.0 * cBot);
        const autoMakeup = getAutoMakeupGain(thresholdVal, ratioVal);
        const limitGain = targetGain / autoMakeup;
        
        window.masterCompressor.threshold.setValueAtTime(thresholdVal, window.audioCtx.currentTime);
        window.masterCompressor.ratio.setValueAtTime(ratioVal, window.audioCtx.currentTime);
        window.masterLimiter.gain.setValueAtTime(limitGain, window.audioCtx.currentTime);
    };

    window.updateMasterLimiter = function(cTop, cBot) {
        if (!window.project) return;
        window.project.masterCompressTop = cTop;
        window.project.masterCompressBottom = cBot;
        window.updateMasterCompressorAndLimiter();
    };

    window.isParentAccessible = isParentAccessible;
    window.isTopAccessible = isTopAccessible;

})();
