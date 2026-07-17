(function() {
    "use strict";

    window.audioWaveCache = new Map(); // src -> Float32Array of peak levels
    const decodingQueue = new Map(); // src -> Promise

    let sharedAudioCtx = null;
    function getSharedAudioContext() {
        if (!sharedAudioCtx) {
            sharedAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
        }
        return sharedAudioCtx;
    }

    async function decodeAudioFile(src) {
        if (window.audioWaveCache.has(src)) {
            return window.audioWaveCache.get(src);
        }
        if (decodingQueue.has(src)) {
            return decodingQueue.get(src);
        }

        const decodePromise = (async () => {
            try {
                // Ensure proper path resolution (handle relative and absolute project paths)
                let fetchUrl = src;
                if (!src.startsWith('http') && !src.startsWith('/')) {
                    fetchUrl = '/' + src;
                }
                const response = await fetch(encodeURI(fetchUrl));
                if (!response.ok) throw new Error(`HTTP error fetching audio: ${response.status}`);
                const arrayBuffer = await response.arrayBuffer();
                const audioCtx = getSharedAudioContext();
                const audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);
                
                // Extract and downsample channel data to peaks
                const numChannels = audioBuffer.numberOfChannels;
                const channelDatas = [];
                for (let c = 0; c < numChannels; c++) {
                    channelDatas.push(audioBuffer.getChannelData(c));
                }
                const numPeaks = 1000;
                const peaks = new Float32Array(numPeaks);
                const sampleStep = Math.floor(audioBuffer.length / numPeaks) || 1;
                
                let sumSq = 0;
                const leftChannel = channelDatas[0];
                for (let i = 0; i < leftChannel.length; i++) {
                    const val = leftChannel[i];
                    sumSq += val * val;
                }
                const rms = Math.sqrt(sumSq / leftChannel.length || 1);

                let maxPeak = 0;
                for (let i = 0; i < numPeaks; i++) {
                    let maxVal = 0;
                    const start = i * sampleStep;
                    const end = Math.min(audioBuffer.length, start + sampleStep);
                    for (let j = start; j < end; j++) {
                        for (let c = 0; c < numChannels; c++) {
                            const val = Math.abs(channelDatas[c][j]);
                            if (val > maxVal) maxVal = val;
                        }
                    }
                    peaks[i] = maxVal;
                    if (maxVal > maxPeak) maxPeak = maxVal;
                }
                
                // Normalize and apply visual compression curve
                if (maxPeak > 0) {
                    for (let i = 0; i < numPeaks; i++) {
                        const norm = peaks[i] / maxPeak;
                        peaks[i] = Math.pow(norm, 0.65);
                    }
                }
                
                const result = { peaks, rms, duration: audioBuffer.duration };
                window.audioWaveCache.set(src, result);
                return result;
            } catch (err) {
                console.error("Audio visualizer decoding failed for:", src, err);
                // Return dummy peaks as fallback
                const fallbackPeaks = new Float32Array(100).map(() => 0.1 + 0.3 * Math.random());
                const fallback = { peaks: fallbackPeaks, rms: 0.15, duration: 10.0 };
                window.audioWaveCache.set(src, fallback);
                return fallback;
            } finally {
                decodingQueue.delete(src);
            }
        })();

        decodingQueue.set(src, decodePromise);
        return decodePromise;
    }

    window.AudioVisualizer = {
        getCache() {
            return window.audioWaveCache;
        },

        async getAudioData(src) {
            return await decodeAudioFile(src);
        },

        drawWaveformSync(canvas, data, color, customWidth, customHeight, sourceStart, duration) {
            const ctx = canvas.getContext('2d');
            const w = canvas.width = customWidth || canvas.clientWidth || (canvas.parentNode ? canvas.parentNode.clientWidth : 0) || 100;
            const h = canvas.height = customHeight || canvas.clientHeight || (canvas.parentNode ? canvas.parentNode.clientHeight : 0) || 44;
            
            if (w <= 0 || h <= 0) return;

            const peaks = data.peaks;
            ctx.clearRect(0, 0, w, h);
            ctx.fillStyle = color;
            
            const barWidth = 2;
            const gap = 1;
            const numBars = Math.floor(w / (barWidth + gap));
            if (numBars <= 0) return;
            
            const clipDur = duration || data.duration || 10;
            const startOffset = sourceStart || 0.0;
            
            for (let i = 0; i < numBars; i++) {
                const t1 = startOffset + (i / numBars) * clipDur;
                const t2 = startOffset + ((i + 1) / numBars) * clipDur;
                
                let startIdx = Math.floor((t1 / (data.duration || clipDur)) * peaks.length);
                let endIdx = Math.floor((t2 / (data.duration || clipDur)) * peaks.length);
                
                startIdx = Math.max(0, Math.min(peaks.length - 1, startIdx));
                endIdx = Math.max(startIdx + 1, Math.min(peaks.length, endIdx));
                
                let peak = 0;
                for (let j = startIdx; j < endIdx; j++) {
                    if (peaks[j] > peak) peak = peaks[j];
                }
                
                // Draw symmetrical bar
                const barHeight = Math.max(2, peak * h * 0.85);
                const x = i * (barWidth + gap);
                const y = (h - barHeight) / 2;
                ctx.fillRect(x, y, barWidth, barHeight);
            }
        },

        async drawWaveform(canvas, src, color = 'rgba(59, 130, 246, 0.7)', customWidth = null, customHeight = null, sourceStart = 0, duration = null) {
            if (src.startsWith('project:') || src.includes('render-host.html') || src.toLowerCase().endsWith('.html')) {
                const ctx = canvas.getContext('2d');
                const w = canvas.width = customWidth || canvas.clientWidth || (canvas.parentNode ? canvas.parentNode.clientWidth : 0) || 100;
                const h = canvas.height = customHeight || canvas.clientHeight || (canvas.parentNode ? canvas.parentNode.clientHeight : 0) || 44;
                ctx.clearRect(0, 0, w, h);
                ctx.fillStyle = 'rgba(255, 255, 255, 0.05)';
                ctx.fillRect(0, 0, w, h);
                ctx.strokeStyle = 'rgba(255, 255, 255, 0.15)';
                ctx.lineWidth = 1;
                ctx.beginPath();
                ctx.moveTo(0, h / 2);
                ctx.lineTo(w, h / 2);
                ctx.stroke();
                return;
            }

            const cached = window.audioWaveCache.get(src);
            if (cached) {
                this.drawWaveformSync(canvas, cached, color, customWidth, customHeight, sourceStart, duration);
                return;
            }

            // Draw placeholder synchronously
            const ctx = canvas.getContext('2d');
            const w = canvas.width = customWidth || canvas.clientWidth || (canvas.parentNode ? canvas.parentNode.clientWidth : 0) || 100;
            const h = canvas.height = customHeight || canvas.clientHeight || (canvas.parentNode ? canvas.parentNode.clientHeight : 0) || 44;
            ctx.clearRect(0, 0, w, h);
            ctx.fillStyle = 'rgba(255, 255, 255, 0.1)';
            ctx.fillRect(0, h / 2 - 1, w, 2);

            try {
                const data = await decodeAudioFile(src);
                this.drawWaveformSync(canvas, data, color, customWidth, customHeight, sourceStart, duration);
            } catch(e) {
                console.error("Async waveform render failed:", e);
            }
        }
    };
})();
