const express = require('express');
const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { exec } = require('child_process');
const AdmZip = require('adm-zip');

// CLI Preview Renderer mode
if (process.argv.includes('--preview')) {
    const previewIdx = process.argv.indexOf('--preview');
    const timeVal = parseFloat(process.argv[previewIdx + 1]);
    
    const outputIdx = process.argv.indexOf('--output');
    const outputPath = process.argv[outputIdx + 1];
    
    if (isNaN(timeVal) || !outputPath) {
        console.error("Usage: node server.js --preview <time_seconds> --output <output_path> [--width <w>] [--height <h>]");
        process.exit(1);
    }
    
    const widthIdx = process.argv.indexOf('--width');
    const width = widthIdx !== -1 ? parseInt(process.argv[widthIdx + 1]) : 1920;
    
    const heightIdx = process.argv.indexOf('--height');
    const height = heightIdx !== -1 ? parseInt(process.argv[heightIdx + 1]) : 1080;
    
    (async () => {
        console.log(`Rendering preview frame at T=${timeVal}s (${width}x${height}) -> ${outputPath}`);
        const projectIdx = process.argv.indexOf('--project');
        const projectName = projectIdx !== -1 ? process.argv[projectIdx + 1] : 'default';
        const safeName = projectName.replace(/[^a-zA-Z0-9\-_]/g, '_');
        const statePath = path.join(__dirname, 'public', 'projects', safeName, 'project_state.json');
        
        if (!fs.existsSync(statePath)) {
            console.error(`Error: ${statePath} does not exist. Save the project in the editor first.`);
            process.exit(1);
        }
        
        let project = { tracks: [] };
        try {
            project = JSON.parse(fs.readFileSync(statePath, 'utf8'));
        } catch (err) {
            console.error(`Error parsing project_state.json at ${statePath}:`, err);
            process.exit(1);
        }
        
        const projectBase64 = Buffer.from(JSON.stringify(project)).toString('base64');
        const localHostPath = path.join(__dirname, 'public', 'render-host.html');
        const fileUrl = `file:///${localHostPath.replace(/\\/g, '/')}?project=${encodeURIComponent(projectBase64)}&width=${width}&height=${height}&duration=300`;
        
        let browser;
        try {
            browser = await puppeteer.launch({
                headless: true,
                args: [
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-web-security',
                    '--allow-file-access-from-files'
                ]
            });
            
            const page = await browser.newPage();
            page.on('console', msg => console.log('PAGE LOG:', msg.text()));
            page.on('pageerror', err => console.error('PAGE ERROR:', err.toString()));
            page.on('requestfailed', req => console.log('REQUEST FAILED:', req.url(), req.failure() ? req.failure().errorText : ''));
            await page.setViewport({ width, height });
            
            console.log("Loading render host...");
            await page.goto(fileUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
            await page.waitForFunction('typeof window.isReady === "function" && window.isReady() === true', { timeout: 30000 });
            
            console.log(`Seeking to T=${timeVal}s...`);
            await page.evaluate((t) => {
                if (typeof window.seekTo === 'function') {
                    window.seekTo(t);
                }
            }, timeVal);
            
            // Allow animations/scripts to settle
            await new Promise(resolve => setTimeout(resolve, 300));
            
            console.log("Capturing frame...");
            const screenshotBuffer = await page.screenshot({
                type: 'png'
            });
            
            fs.writeFileSync(outputPath, screenshotBuffer);
            console.log(`Preview frame saved successfully to: ${outputPath}`);
            process.exit(0);
        } catch (err) {
            console.error("Preview render failed:", err);
            process.exit(1);
        } finally {
            if (browser) await browser.close();
        }
    })();
    return; // Prevent starting the Express app
}

const app = express();
const PORT = process.env.PORT || 3333;
let inpaintDaemonProcess = null;

// Increase payload limit for base64 file uploads and project state
app.use(express.json({ limit: '500mb' }));
app.use(express.urlencoded({ limit: '500mb', extended: true }));
app.use('/api/upload-client-render-chunk', express.raw({ type: '*/*', limit: '2gb' }));
app.use('/api/upload-client-render-chunk-append', express.raw({ type: '*/*', limit: '500mb' }));

// Define directory paths
const publicDir = path.join(__dirname, 'public');
const tempDir = path.join(__dirname, 'temp');
const rendersDir = path.join(__dirname, 'renders');

// Ensure necessary directories exist
[publicDir, tempDir, rendersDir].forEach(dir => {
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
});

// Helper function to dynamically resolve isolated project paths
function getProjectPaths(projectName) {
    const safeName = (projectName || 'default')
        .replace(/\\/g, '/')
        .replace(/\.\./g, '_')
        .replace(/[^a-zA-Z0-9\-_\/]/g, '_');
    const projectDir = path.join(publicDir, 'projects', safeName);
    const compsDir = path.join(projectDir, 'compositions');
    const assetsDir = path.join(projectDir, 'assets');
    const statePath = path.join(projectDir, 'project_state.json');
    const deletedDir = path.join(projectDir, 'deleted');
    const deletedCompositionsDir = path.join(deletedDir, 'compositions');
    const deletedAssetsDir = path.join(deletedDir, 'assets');
    
    // Ensure paths exist
    [projectDir, compsDir, assetsDir].forEach(dir => {
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
    });
    
    return {
        projectDir,
        compositionsDir: compsDir,
        assetsDir,
        statePath,
        deletedDir,
        deletedCompositionsDir,
        deletedAssetsDir
    };
}

// 1. Serve static files from the public directory
app.use(express.static(publicDir));
// Also expose the renders folder so the client can download/play completed videos
app.use('/renders', express.static(rendersDir));

// Helper function to recursively delete a directory and its contents
function deleteFolderRecursive(directoryPath) {
    if (fs.existsSync(directoryPath)) {
        fs.readdirSync(directoryPath).forEach((file) => {
            const curPath = path.join(directoryPath, file);
            if (fs.lstatSync(curPath).isDirectory()) {
                deleteFolderRecursive(curPath);
            } else {
                fs.unlinkSync(curPath);
            }
        });
        fs.rmdirSync(directoryPath);
    }
}

// New endpoint: GET /api/projects: List all project names
app.get('/api/projects', (req, res) => {
    const projectsDir = path.join(publicDir, 'projects');
    if (!fs.existsSync(projectsDir)) {
        return res.json({ projects: [] });
    }
    fs.readdir(projectsDir, (err, files) => {
        if (err) {
            console.error('Error reading projects directory:', err);
            return res.status(500).json({ error: 'Failed to read projects.' });
        }
        const projects = files.filter(file => {
            const fullPath = path.join(projectsDir, file);
            return fs.lstatSync(fullPath).isDirectory();
        });
        return res.json({ projects });
    });
});

// 2. Endpoint GET /api/compositions: List allowed media files
app.get('/api/compositions', (req, res) => {
    const allowedExtensions = ['.html', '.mp4', '.webm', '.png', '.jpg', '.jpeg', '.gif', '.mp3', '.wav', '.ogg'];
    const project = req.query.project || 'default';
    
    const resolveComps = (projName) => {
        const { compositionsDir } = getProjectPaths(projName);
        if (!fs.existsSync(compositionsDir)) return [];
        try {
            return fs.readdirSync(compositionsDir).map(file => {
                const ext = path.extname(file).toLowerCase();
                if (!allowedExtensions.includes(ext)) return null;
                const safeProj = projName.replace(/\\/g, '/').replace(/\.\./g, '_').replace(/[^a-zA-Z0-9\-_\/]/g, '_');
                return {
                    name: file,
                    src: `projects/${safeProj}/compositions/${file}`
                };
            }).filter(Boolean);
        } catch (e) {
            return [];
        }
    };
    
    let list = resolveComps(project);
    if (project.includes('/')) {
        const parentProj = project.split('/')[0];
        const parentList = resolveComps(parentProj);
        const names = new Set(list.map(x => x.name));
        parentList.forEach(item => {
            if (!names.has(item.name)) {
                list.push(item);
                names.add(item.name);
            }
        });
    }
    
    return res.json(list);
});

// 3. Endpoint POST /api/upload: Upload asset or composition
app.post('/api/upload', (req, res) => {
    const { name, data, project } = req.body;
    const projName = project || req.query.project || 'default';
    const { compositionsDir } = getProjectPaths(projName);
    
    if (!name || !data) {
        return res.status(400).json({ error: 'Missing name or data payload.' });
    }
    
    try {
        const buffer = Buffer.from(data, 'base64');
        const targetPath = path.join(compositionsDir, name);
        
        fs.writeFile(targetPath, buffer, (err) => {
            if (err) {
                console.error('Error writing file:', err);
                return res.status(500).json({ error: 'Failed to save file to disk.' });
            }
            return res.json({ success: true, message: `File ${name} saved successfully.` });
        });
    } catch (error) {
        console.error('Error decoding base64 data:', error);
        return res.status(500).json({ error: 'Invalid base64 payload data.' });
    }
});

// 4. Endpoint DELETE /api/delete: Delete target asset from disk
app.delete('/api/delete', (req, res) => {
    const { name, project } = req.query;
    const projName = project || 'default';
    const { compositionsDir } = getProjectPaths(projName);
    
    if (!name) {
        return res.status(400).json({ error: 'Missing file name parameter.' });
    }
    
    const targetPath = path.join(compositionsDir, name);
    
    // Safety check to avoid Directory Traversal vulnerabilities
    const relative = path.relative(compositionsDir, targetPath);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
        return res.status(403).json({ error: 'Access denied.' });
    }
    
    if (!fs.existsSync(targetPath)) {
        return res.status(404).json({ error: 'File not found.' });
    }
    
    fs.unlink(targetPath, (err) => {
        if (err) {
            console.error('Error deleting file:', err);
            return res.status(500).json({ error: 'Failed to delete file.' });
        }
        return res.json({ success: true, message: `File ${name} deleted successfully.` });
    });
});

// Helper function to wrap exec into a promise
function execPromise(command) {
    return new Promise((resolve, reject) => {
        exec(command, (error, stdout, stderr) => {
            if (error) {
                reject(error);
            } else {
                resolve({ stdout, stderr });
            }
        });
    });
}

// 5. Endpoint POST /api/render: Parallel framework compiler pipeline
app.post('/api/render', async (req, res) => {
    const { project, settings } = req.body;
    
    if (!project) {
        return res.status(400).json({ error: 'Missing project data payload.' });
    }
    
    // Set headers immediately to establish Server-Sent Events stream
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    
    const sendStatus = (type, data) => {
        res.write(`data: ${JSON.stringify({ type, ...data })}\n\n`);
    };
    
    // Resolve configuration defaults
    const width = parseInt(settings?.width) || 1920;
    const height = parseInt(settings?.height) || 1080;
    const fps = parseInt(settings?.fps) || 30;
    const duration = parseFloat(settings?.duration) || 15;
    const renderMode = settings?.renderMode || 'pipe';
    
    const totalFrames = Math.ceil(duration * fps);
    const renderId = Date.now();
    
    const tempVideoPath = path.join(tempDir, `temp_video_${renderId}.mp4`);
    const tempAudioPath = path.join(tempDir, `temp_audio_${renderId}.wav`);
    const finalOutputPath = path.join(rendersDir, `render_${renderId}.mp4`);
    const framesDir = path.join(tempDir, `frames_${renderId}`);
    const tempStatePath = path.join(tempDir, `project_state_${renderId}.json`);
    
    let browser = null;
    let audioFileExists = false;
    let isFinished = false;
    let ffmpegProcess = null;
    res.on('close', async () => {
        console.log(`[Render] res close event fired for job ${renderId}. socket destroyed: ${req.socket.destroyed}, writable: ${req.socket.writable}`);
        if (!isFinished) {
            if (req.socket.destroyed) {
                console.log(`[Render] Request connection closed by client (aborted) for render job ID: ${renderId}.`);
                isFinished = true;
                if (browser) {
                    try {
                        await browser.close();
                        browser = null;
                        console.log(`[Render] Puppeteer browser terminated for aborted job ${renderId}.`);
                    } catch (e) {
                        console.error("Error closing browser on abort:", e);
                    }
                }
                if (ffmpegProcess) {
                    try {
                        ffmpegProcess.kill('SIGINT');
                        ffmpegProcess = null;
                        console.log(`[Render] FFmpeg process terminated for aborted job ${renderId}.`);
                    } catch (e) {
                        console.error("Error killing FFmpeg process on abort:", e);
                    }
                }
                cleanupTemporaryFiles(framesDir, tempVideoPath, tempAudioPath, tempStatePath);
            } else {
                console.log(`[Render] Ignoring close event since socket is not destroyed for job ${renderId}.`);
            }
        }
    });
    
    try {
        sendStatus('status', { message: 'Initializing temp folders...', progress: 1 });
        
        // Ensure frame subdirectory exists
        if (!fs.existsSync(framesDir)) {
            fs.mkdirSync(framesDir, { recursive: true });
        }
        
        // Check system availability of FFmpeg
        try {
            await execPromise('ffmpeg -version');
        } catch (err) {
            throw new Error('FFmpeg is not installed or available in system PATH.');
        }
        
        // Save project state to temp file to bypass URL length limits and HTTP 431 header limits
        fs.writeFileSync(tempStatePath, JSON.stringify(project));
        const renderHostUrl = `http://localhost:${PORT}/render-host.html?project_name=render_temp_${renderId}&width=${width}&height=${height}&duration=${duration}`;
        
        console.log(`Starting render job ID: ${renderId}. Mode: ${renderMode}. Total Frames to compile: ${totalFrames}`);
        sendStatus('status', { message: 'Launching headless Chromium browser...', progress: 3 });
        
        // Boot up optimized headless Chrome instance
        browser = await puppeteer.launch({
            headless: true,
            protocolTimeout: 300000, // 5 minutes timeout
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-web-security',
                '--disable-gpu',
                '--disable-dev-shm-usage',
                '--allow-file-access-from-files'
            ]
        });

        const { spawn } = require('child_process');

        let ffmpegStderrLog = "";
        let writeError = null;

        const ensureFFmpegSpawned = () => {
            if (ffmpegProcess) return;

            console.log(`[Render] Spawning FFmpeg process dynamically for job ${renderId}`);
            ffmpegProcess = spawn('ffmpeg', [
                '-y',
                '-f', 'image2pipe',
                '-vcodec', 'mjpeg',
                '-framerate', String(fps),
                '-i', '-',
                '-an',
                '-c:v', 'libx264',
                '-pix_fmt', 'yuv420p',
                '-crf', '18',
                tempVideoPath
            ]);

            ffmpegProcess.stderr.on('data', (chunk) => {
                ffmpegStderrLog += chunk.toString();
            });

            ffmpegProcess.on('error', (err) => {
                console.error("[Render] FFmpeg process error event:", err);
                writeError = err;
            });

            ffmpegProcess.on('exit', (code, signal) => {
                if (code !== 0 && code !== null) {
                    console.error(`[Render] FFmpeg process exited with non-zero code ${code} (signal: ${signal})`);
                    writeError = new Error(`FFmpeg exited with code ${code}. Stderr:\n${ffmpegStderrLog}`);
                }
            });
        };

        if (renderMode === 'screencast') {
            console.log(`[Render] Initializing Real-time Headless CDP Screencast mode for job ${renderId}`);
            sendStatus('status', { message: 'Starting real-time screencast stream...', progress: 5 });

            const page = await browser.newPage();
            page.on('console', msg => console.log('[Screencast Page Log]', msg.text()));
            page.on('pageerror', err => console.error('[Screencast Page Error]', err.toString()));
            page.on('requestfailed', req => console.log('[Screencast Request Failed]', req.url(), req.failure() ? req.failure().errorText : ''));
            await page.setViewport({ width, height });

            try {
                await page.goto(renderHostUrl, { waitUntil: 'domcontentloaded', timeout: 120000 });
                await page.waitForFunction('typeof window.isReady === "function" && window.isReady() === true', { timeout: 120000 });
            } catch (timeoutErr) {
                console.warn(`Warning: Handshake timed out. Proceeding blind.`);
            }

            let tStart = null;
            let screencastFrameCount = 0;
            let lastFrameBuffer = null;
            
            const client = await page.target().createCDPSession();
            await client.send('Page.startScreencast', { format: 'jpeg', quality: 90, everyNthFrame: 1 });
            
            client.on('Page.screencastFrame', async (frame) => {
                try {
                    if (!isFinished && !writeError) {
                        ensureFFmpegSpawned();
                        if (ffmpegProcess && ffmpegProcess.stdin.writable) {
                            const buffer = Buffer.from(frame.data, 'base64');
                            lastFrameBuffer = buffer;
                            const timestamp = frame.metadata.timestamp;
                            
                            if (tStart === null) {
                                tStart = timestamp;
                            }
                            
                            const elapsed = timestamp - tStart;
                            const targetFrame = Math.floor(elapsed * fps);
                            
                            let repeatCount = 1;
                            if (targetFrame > screencastFrameCount) {
                                repeatCount = targetFrame - screencastFrameCount + 1;
                            } else if (targetFrame < screencastFrameCount) {
                                repeatCount = 0;
                            }
                            
                            repeatCount = Math.min(repeatCount, 150);

                            // Do not write more frames than totalFrames to maintain absolute sync with audio duration
                            if (screencastFrameCount + repeatCount > totalFrames) {
                                repeatCount = totalFrames - screencastFrameCount;
                            }

                            for (let r = 0; r < repeatCount; r++) {
                                ffmpegProcess.stdin.write(buffer);
                                screencastFrameCount++;
                            }

                            if (screencastFrameCount % 10 === 0 || screencastFrameCount >= totalFrames - 1) {
                                const estProgress = Math.min(89, Math.round((screencastFrameCount / totalFrames) * 90));
                                sendStatus('progress', {
                                    progress: estProgress,
                                    frame: screencastFrameCount,
                                    total: totalFrames
                                });
                            }
                        }
                    }
                    await client.send('Page.screencastFrameAck', { sessionId: frame.sessionId });
                } catch (err) {
                    console.error("Error processing screencast frame:", err);
                }
            });

            // Start timeline playback
            await page.evaluate(() => {
                if (typeof window.seekTo === 'function') window.seekTo(0);
                if (typeof window.setPlaybackState === 'function') window.setPlaybackState(true);
            });

            // Wait for duration of video + small buffer
            await new Promise(resolve => setTimeout(resolve, duration * 1000 + 1000));

            try {
                await client.send('Page.stopScreencast');
            } catch (e) {
                console.error("Error stopping screencast:", e);
            }
            
            // Fill any remaining frames to totalFrames to ensure exact sync
            if (screencastFrameCount < totalFrames && lastFrameBuffer && ffmpegProcess && ffmpegProcess.stdin.writable) {
                const fillCount = totalFrames - screencastFrameCount;
                console.log(`[Render] Filling remaining ${fillCount} frames to match total ${totalFrames} frames`);
                for (let r = 0; r < fillCount; r++) {
                    ffmpegProcess.stdin.write(lastFrameBuffer);
                    screencastFrameCount++;
                }
            }
            
            await page.close();

            if (ffmpegProcess) {
                if (writeError) throw writeError;
                ffmpegProcess.stdin.end();
                await new Promise((resolve, reject) => {
                    ffmpegProcess.on('close', (code) => {
                        ffmpegProcess = null;
                        if (code === 0) {
                            resolve();
                        } else {
                            console.error("[FFmpeg Screencast Stderr]:", ffmpegStderrLog);
                            reject(writeError || new Error(`FFmpeg screencast exited with code ${code}. Stderr:\n${ffmpegStderrLog}`));
                        }
                    });
                });
            }

        } else {
            // Mode 1: Deterministic Headless Stdin Pipe
            console.log(`[Render] Initializing Deterministic Headless Stdin Pipe mode for job ${renderId}`);
            sendStatus('status', { message: 'Spawning worker pages...', progress: 5 });

            const requestedConcurrency = parseInt(settings?.concurrency);
            const CONCURRENCY = !isNaN(requestedConcurrency) ? Math.max(1, requestedConcurrency) : 1;
            
            let nextFrameIndex = 0;
            let nextFrameToWrite = 0;
            const capturedFrames = {};
            const workerPromises = [];
            
            for (let i = 0; i < CONCURRENCY; i++) {
                workerPromises.push((async (workerId) => {
                    const page = await browser.newPage();
                    page.on('console', msg => console.log(`[Worker ${workerId} Page Log]`, msg.text()));
                    page.on('pageerror', err => console.error(`[Worker ${workerId} Page Error]`, err.toString()));
                    page.on('requestfailed', req => console.log(`[Worker ${workerId} Request Failed]`, req.url(), req.failure() ? req.failure().errorText : ''));
                    await page.setViewport({ width, height });
                    
                    try {
                        await page.goto(renderHostUrl, { waitUntil: 'domcontentloaded', timeout: 120000 });
                        await page.waitForFunction('typeof window.isReady === "function" && window.isReady() === true', { timeout: 120000 });
                    } catch (timeoutErr) {
                        console.warn(`[Worker ${workerId}] Warning: Application readiness handshake timed out. Proceeding blind.`);
                    }
                    
                    while (true) {
                        if (isFinished || writeError) {
                            console.log(`[Worker ${workerId}] Loop breaking: isFinished=${isFinished}, writeError=${writeError}`);
                            break;
                        }

                        const currentFrame = nextFrameIndex++;
                        console.log(`[Worker ${workerId}] Processing frame ${currentFrame}/${totalFrames}`);
                        if (currentFrame >= totalFrames) {
                            break;
                        }
                        
                        const time = currentFrame / fps;
                        
                        try {
                            await page.evaluate((t) => {
                                if (typeof window.seekTo === 'function') {
                                    window.seekTo(t);
                                }
                            }, time);
                            
                            await new Promise(resolve => setTimeout(resolve, 5));
                            
                            const screenshotBuffer = await page.screenshot({
                                type: 'jpeg',
                                quality: 90
                            });
                            console.log(`[Worker ${workerId}] Screenshot captured for frame ${currentFrame}`);

                            capturedFrames[currentFrame] = screenshotBuffer;

                            // Pipe available sequential frames to FFmpeg stdin
                            while (capturedFrames[nextFrameToWrite]) {
                                if (writeError) {
                                    console.log(`[Worker ${workerId}] Write loop breaking due to writeError`);
                                    break;
                                }
                                
                                console.log(`[Worker ${workerId}] Writing frame ${nextFrameToWrite} to FFmpeg`);
                                ensureFFmpegSpawned();
                                if (ffmpegProcess && ffmpegProcess.stdin.writable) {
                                    try {
                                        ffmpegProcess.stdin.write(capturedFrames[nextFrameToWrite]);
                                    } catch (e) {
                                        console.error("Error writing frame to FFmpeg stdin:", e);
                                        writeError = e;
                                    }
                                }
                                delete capturedFrames[nextFrameToWrite];
                                nextFrameToWrite++;
                            }
                            
                            if (currentFrame % 10 === 0 || currentFrame === totalFrames - 1) {
                                sendStatus('progress', {
                                    progress: Math.round((currentFrame / totalFrames) * 90),
                                    frame: currentFrame,
                                    total: totalFrames
                                });
                            }
                        } catch (err) {
                            console.error(`[Worker ${workerId}] Error in loop for frame ${currentFrame}:`, err);
                            writeError = err;
                            break;
                        }
                    }
                    
                    await page.close();
                })(i));
            }
            
            await Promise.all(workerPromises);

            if (ffmpegProcess) {
                if (writeError) throw writeError;
                ffmpegProcess.stdin.end();
                await new Promise((resolve, reject) => {
                    ffmpegProcess.on('close', (code) => {
                        ffmpegProcess = null;
                        if (code === 0) {
                            resolve();
                        } else {
                            console.error("[FFmpeg Stdin Pipe Stderr]:", ffmpegStderrLog);
                            reject(new Error(`FFmpeg pipe exited with code ${code}. Stderr:\n${ffmpegStderrLog}`));
                        }
                    });
                });
            }
        }
        
        console.log(`All frame capture extraction streams complete. Extracting audio metadata matrix...`);
        sendStatus('status', { message: 'Rendering and mixing audio buffer...', progress: 92 });
        
        // Audio extraction loop pass using context isolation
        const audioPage = await browser.newPage();
        audioPage.on('console', msg => console.log('[Audio Page Log]', msg.text()));
        audioPage.on('pageerror', err => console.error('[Audio Page Error]', err.toString()));
        audioPage.on('requestfailed', req => console.log('[Audio Request Failed]', req.url(), req.failure() ? req.failure().errorText : ''));
        await audioPage.setViewport({ width, height });
        
        try {
            await audioPage.goto(renderHostUrl, { waitUntil: 'domcontentloaded', timeout: 120000 });
            await audioPage.waitForFunction('typeof window.isReady === "function" && window.isReady() === true', { timeout: 120000 });
            
            const base64WavData = await audioPage.evaluate(async (d) => {
                if (typeof window.renderAudioOffline === 'function') {
                    return await window.renderAudioOffline(d);
                }
                return null;
            }, duration);
            
            if (base64WavData) {
                const cleanBase64 = base64WavData.replace(/^data:audio\/\w+;base64,/, "");
                fs.writeFileSync(tempAudioPath, Buffer.from(cleanBase64, 'base64'));
                audioFileExists = true;
                console.log("Audio synthesis buffer tracking recorded successfully.");
            } else {
                console.log("No audio tracks found or returned from application framework wrapper layer.");
            }
        } catch (audioErr) {
            console.error("Audio generation pass encountered errors. Video output might be silent:", audioErr);
        } finally {
            await audioPage.close();
        }
        
        await browser.close();
        browser = null; 
        
        console.log("Muxing final video streaming layers...");
        sendStatus('status', { message: 'Muxing audio and video streams...', progress: 98 });
        
        let finalMuxCmd = '';
        if (audioFileExists && fs.existsSync(tempAudioPath)) {
            finalMuxCmd = `ffmpeg -y -i "${tempVideoPath}" -i "${tempAudioPath}" -c:v copy -c:a aac -b:a 256k "${finalOutputPath}"`;
        } else {
            finalMuxCmd = `ffmpeg -y -i "${tempVideoPath}" -c:v copy "${finalOutputPath}"`;
        }
        await execPromise(finalMuxCmd);
        
        cleanupTemporaryFiles(framesDir, tempVideoPath, tempAudioPath, tempStatePath);
        
        console.log(`Render generation phase complete: render_${renderId}.mp4`);
        isFinished = true;
        sendStatus('success', {
            filename: `render_${renderId}.mp4`,
            path: `/renders/render_${renderId}.mp4`
        });
        res.end();
        
    } catch (globalRenderError) {
        console.error("Critical error inside tracking render engine loop pipeline:", globalRenderError);
        
        isFinished = true;
        
        if (browser) {
            try { await browser.close(); } catch (e) { console.error("Error closing browser on crash:", e); }
        }
        if (ffmpegProcess) {
            try { ffmpegProcess.kill('SIGINT'); } catch (e) {}
        }
        
        cleanupTemporaryFiles(framesDir, tempVideoPath, tempAudioPath, tempStatePath);
        
        if (!res.writableEnded) {
            sendStatus('error', { message: globalRenderError.message || 'Render pipeline crashed.' });
            res.end();
        }
    }
});

// Endpoint POST /api/upload-client-render-chunk
app.post('/api/upload-client-render-chunk', async (req, res) => {
    const jobId = req.query.job_id;
    const chunkType = req.query.type; // 'video' or 'audio'
    if (!jobId || !chunkType) {
        return res.status(400).send('Missing job_id or type.');
    }
    
    const ext = chunkType === 'video' ? 'webm' : 'wav';
    const filePath = path.join(tempDir, `temp_client_${chunkType}_${jobId}.${ext}`);
    
    try {
        fs.writeFileSync(filePath, req.body);
        res.json({ success: true });
    } catch (err) {
        console.error(`[Upload] Failed to save ${chunkType} chunk for job ${jobId}:`, err);
        res.status(500).send(err.message);
    }
});

// Endpoint POST /api/upload-client-render-chunk-append
// Appends a binary chunk to the temp video file on disk (streaming mode).
app.post('/api/upload-client-render-chunk-append', async (req, res) => {
    const jobId = req.query.job_id;
    if (!jobId) return res.status(400).send('Missing job_id.');
    const filePath = path.join(tempDir, `temp_client_video_${jobId}.webm`);
    try {
        fs.appendFileSync(filePath, req.body);
        res.json({ success: true });
    } catch (err) {
        console.error(`[Upload] Failed to append video chunk for job ${jobId}:`, err);
        res.status(500).send(err.message);
    }
});

// Endpoint POST /api/mux-client-render
app.post('/api/mux-client-render', async (req, res) => {
    const { videoBase64, audioBase64, job_id, hasAudio } = req.body;
    
    if (job_id) {
        const tempVideoPath = path.join(tempDir, `temp_client_video_${job_id}.webm`);
        const tempAudioPath = path.join(tempDir, `temp_client_audio_${job_id}.wav`);
        const finalOutputPath = path.join(rendersDir, `render_${job_id}.mp4`);
        
        try {
            if (!fs.existsSync(tempVideoPath)) {
                return res.status(400).json({ error: 'Missing video file on server.' });
            }
            
            const audioExists = hasAudio && fs.existsSync(tempAudioPath);
            
            // Mux video and audio using FFmpeg to high-compatibility MP4
            if (audioExists) {
                console.log(`[Mux] Muxing client-side WebCodecs video and WAV audio for job ${job_id}`);
                await execPromise(`ffmpeg -y -i "${tempVideoPath}" -i "${tempAudioPath}" -c:v copy -c:a aac -b:a 192k "${finalOutputPath}"`);
            } else {
                console.log(`[Mux] Muxing silent client-side video to MP4 for job ${job_id}`);
                await execPromise(`ffmpeg -y -i "${tempVideoPath}" -c:v copy "${finalOutputPath}"`);
            }
            
            // Clean up temp files
            cleanupTemporaryFiles("", tempVideoPath, tempAudioPath, "");
            
            res.json({ success: true, path: `/renders/render_${job_id}.mp4` });
        } catch (err) {
            console.error("[Mux] Muxing failed:", err);
            cleanupTemporaryFiles("", tempVideoPath, tempAudioPath, "");
            res.status(500).json({ error: `Muxing failed: ${err.message}` });
        }
        return;
    }

    if (!videoBase64) {
        return res.status(400).json({ error: 'Missing video data.' });
    }
    
    const renderId = Date.now();
    const tempVideoPath = path.join(tempDir, `temp_client_video_${renderId}.webm`);
    const tempAudioPath = path.join(tempDir, `temp_client_audio_${renderId}.wav`);
    const finalOutputPath = path.join(rendersDir, `render_${renderId}.mp4`);
    
    try {
        // Write temp video file
        const videoBuffer = Buffer.from(videoBase64, 'base64');
        fs.writeFileSync(tempVideoPath, videoBuffer);
        
        let clientHasAudio = false;
        if (audioBase64) {
            const audioBuffer = Buffer.from(audioBase64, 'base64');
            fs.writeFileSync(tempAudioPath, audioBuffer);
            clientHasAudio = true;
        }
        
        // Mux video and audio using FFmpeg to high-compatibility MP4
        if (clientHasAudio) {
            console.log(`[Mux] Muxing client-side WebCodecs video and WAV audio for job ${renderId}`);
            await execPromise(`ffmpeg -y -i "${tempVideoPath}" -i "${tempAudioPath}" -c:v copy -c:a aac -b:a 192k "${finalOutputPath}"`);
        } else {
            console.log(`[Mux] Muxing silent client-side video to MP4 for job ${renderId}`);
            await execPromise(`ffmpeg -y -i "${tempVideoPath}" -c:v copy "${finalOutputPath}"`);
        }
        
        // Clean up temp files
        cleanupTemporaryFiles("", tempVideoPath, tempAudioPath, "");
        
        res.json({ success: true, path: `/renders/render_${renderId}.mp4` });
    } catch (err) {
        console.error("[Mux] Muxing failed:", err);
        cleanupTemporaryFiles("", tempVideoPath, tempAudioPath, "");
        res.status(500).json({ error: `Muxing failed: ${err.message}` });
    }
});

// Helper clean up function to remove workspace files
function cleanupTemporaryFiles(framesFolder, rawVideo, rawAudio, tempStatePath) {
    try {
        if (fs.existsSync(framesFolder)) {
            deleteFolderRecursive(framesFolder);
        }
        if (fs.existsSync(rawVideo)) {
            fs.unlinkSync(rawVideo);
        }
        if (fs.existsSync(rawAudio)) {
            fs.unlinkSync(rawAudio);
        }
        if (tempStatePath && fs.existsSync(tempStatePath)) {
            fs.unlinkSync(tempStatePath);
        }
    } catch (cleanupError) {
        console.error("Warning: Non-blocking error occurred cleaning up workspace temp tracks:", cleanupError);
    }
}

// 6. Endpoint POST /api/project/state: Save current project state
app.post('/api/project/state', (req, res) => {
    const project = req.body;
    const projName = req.query.project || 'default';
    const { statePath } = getProjectPaths(projName);
    
    if (!project) {
        return res.status(400).json({ error: 'Missing project payload.' });
    }
    
    fs.writeFile(statePath, JSON.stringify(project, null, 2), (err) => {
        if (err) {
            console.error('Error saving project state:', err);
            return res.status(500).json({ error: 'Failed to save project state.' });
        }
        return res.json({ success: true });
    });
});

// Endpoint POST /api/project/animate: Cut visual clip element and auto-animate it
app.post('/api/project/animate', async (req, res) => {
    const { 
        project: projName, 
        clipId, 
        maskB64, 
        inpaint, 
        startTime, 
        endTime, 
        directionAngle, 
        amplitude, 
        periodicity, 
        pivot,
        animationType,
        dilation,
        animations
    } = req.body;

    if (!projName || !clipId || !maskB64) {
        return res.status(400).json({ error: 'Missing project, clipId, or maskB64 parameters.' });
    }

    const { statePath, compositionsDir } = getProjectPaths(projName);
    
    try {
        if (!fs.existsSync(statePath)) {
            return res.status(404).json({ error: 'Project state not found.' });
        }

        const projectData = JSON.parse(fs.readFileSync(statePath, 'utf8'));
        const originalClip = projectData.tracks.find(t => t.id === clipId);
        if (!originalClip) {
            return res.status(404).json({ error: 'Clip not found in project state.' });
        }

        const newClipId = `clip_${Date.now()}_${Math.floor(Math.random()*1000)}`;

        // 1. Resolve paths
        const srcPath = path.join(publicDir, originalClip.src);
        if (!fs.existsSync(srcPath)) {
            return res.status(404).json({ error: `Original image file not found at ${srcPath}` });
        }

        const tempMaskPath = path.join(tempDir, `temp_mask_${newClipId}.png`);
        fs.writeFileSync(tempMaskPath, Buffer.from(maskB64, 'base64'));

        const isolatedFilename = `${newClipId}_isolated.png`;
        const cleanFilename = `${clipId}_clean.png`;
        const destIsolatedPath = path.join(compositionsDir, isolatedFilename);
        const destCleanPath = path.join(compositionsDir, cleanFilename);

        const safeProjName = projName
            .replace(/\\/g, '/')
            .replace(/\.\./g, '_')
            .replace(/[^a-zA-Z0-9\-_\/]/g, '_');

        const relativeIsolatedSrc = `projects/${safeProjName}/compositions/${isolatedFilename}`;
        const relativeCleanSrc = `projects/${safeProjName}/compositions/${cleanFilename}`;

        // 2. Execute Python animation and cut script
        const dilationVal = dilation !== undefined ? parseInt(dilation) : 4;
        const pythonCmd = `python "${path.join(__dirname, 'animate_clip.py')}" --src "${srcPath}" --mask "${tempMaskPath}" --dest-isolated "${destIsolatedPath}" --dest-clean "${destCleanPath}" ${inpaint ? '--inpaint' : '--no-inpaint'} --dilation ${dilationVal}`;
        
        console.log(`[Animate API] Running script: ${pythonCmd}`);
        await execPromise(pythonCmd);

        // Remove temp mask
        if (fs.existsSync(tempMaskPath)) {
            fs.unlinkSync(tempMaskPath);
        }

        // 3. Find target track for isolated clip
        let targetTrackIndex = -1;
        const originalTrackIndex = originalClip.trackIndex;
        
        const isRangeOccupied = (trackIdx) => {
            return projectData.tracks.some(t => {
                if (t.trackIndex !== trackIdx) return false;
                const end = originalClip.start + originalClip.duration;
                const tEnd = t.start + t.duration;
                return (originalClip.start < tEnd - 0.05) && (t.start < end - 0.05);
            });
        };
        
        if (originalTrackIndex - 1 >= 0 && !isRangeOccupied(originalTrackIndex - 1)) {
            targetTrackIndex = originalTrackIndex - 1;
        } else if (!isRangeOccupied(originalTrackIndex + 1) && originalTrackIndex + 1 < (projectData.trackConfigs || []).length) {
            targetTrackIndex = originalTrackIndex + 1;
        } else {
            // Insert a new track above (at originalTrackIndex)
            projectData.tracks.forEach(clip => {
                if (clip.trackIndex >= originalTrackIndex) {
                    clip.trackIndex += 1;
                }
            });
            if (!projectData.trackConfigs) projectData.trackConfigs = [];
            projectData.trackConfigs.splice(originalTrackIndex, 0, { name: `Track ${projectData.trackConfigs.length + 1}` });
            projectData.trackConfigs.forEach((t, idx) => {
                t.name = `Track ${idx + 1}`;
            });
            targetTrackIndex = originalTrackIndex;
        }

        // 4. Update timeline configuration
        originalClip.src = relativeCleanSrc;
        if (!originalClip.name.includes('(Clean Background)')) {
            originalClip.name = `${originalClip.name} (Clean Background)`;
        }
        delete originalClip.animate_tool; // Ensure background doesn't animate!

        let finalAnimations = animations;
        if (!finalAnimations) {
            finalAnimations = [{
                type: animationType || 'translate',
                start_time: parseFloat(startTime) || 0.0,
                end_time: parseFloat(endTime) || originalClip.duration,
                direction_angle: parseFloat(directionAngle) || 0.0,
                amplitude: parseFloat(amplitude) || 0.0,
                periodicity: parseFloat(periodicity) || 1.0,
                pivot: pivot || [50, 50],
                easing: 'linear'
            }];
        }

        const isolatedClip = {
            id: newClipId,
            src: relativeIsolatedSrc,
            name: `${originalClip.name.replace(' (Clean Background)', '')} (Isolated)`,
            start: originalClip.start,
            duration: originalClip.duration,
            trackIndex: targetTrackIndex,
            fadeIn: 0.0,
            fadeOut: 0.0,
            compressTop: 1.0,
            compressBottom: 0.0,
            panX: originalClip.panX || 0,
            panY: originalClip.panY || 0,
            scale: originalClip.scale !== undefined ? originalClip.scale : 1.0,
            scaleX: originalClip.scaleX !== undefined ? originalClip.scaleX : (originalClip.scale !== undefined ? originalClip.scale : 1.0),
            scaleY: originalClip.scaleY !== undefined ? originalClip.scaleY : (originalClip.scale !== undefined ? originalClip.scale : 1.0),
            rotation: originalClip.rotation || 0,
            opacity: 1.0,
            transitionIn: 'none',
            transitionOut: 'none',
            mirror: originalClip.mirror || false,
            animate_tool: finalAnimations
        };

        projectData.tracks.push(isolatedClip);

        // Write the updated project state
        fs.writeFileSync(statePath, JSON.stringify(projectData, null, 2));

        return res.json({ success: true, project: projectData });

    } catch (err) {
        console.error("[Animate API Error]: Pipeline execution failed.");
        if (err.stdout) console.error(`[Python STDOUT]:\n${err.stdout}`);
        if (err.stderr) console.error(`[Python STDERR]:\n${err.stderr}`);
        return res.status(500).json({ error: err.message || 'Animation pipeline failed.' });
    }
});

// 7. Endpoint GET /api/project/state: Load project state from server
app.get('/api/project/state', (req, res) => {
    const projName = req.query.project || 'default';
    
    if (projName.startsWith('render_temp_')) {
        const renderId = projName.substring(12);
        const tempStatePath = path.join(tempDir, `project_state_${renderId}.json`);
        if (fs.existsSync(tempStatePath)) {
            try {
                const data = fs.readFileSync(tempStatePath, 'utf8');
                return res.json(JSON.parse(data));
            } catch (e) {
                return res.status(500).json({ error: 'Failed to read temp project state.' });
            }
        } else {
            return res.status(404).json({ error: 'Temp project state not found.' });
        }
    }
    
    const { statePath } = getProjectPaths(projName);
    
    if (!fs.existsSync(statePath)) {
        return res.json({ tracks: [], markers: [], trackConfigs: [{ name: "Track 1" }, { name: "Track 2" }, { name: "Track 3" }] });
    }
    fs.readFile(statePath, 'utf8', (err, data) => {
        if (err) {
            console.error('Error reading project state:', err);
            return res.status(500).json({ error: 'Failed to read project state.' });
        }
        try {
            return res.json(JSON.parse(data));
        } catch (e) {
            return res.status(500).json({ error: 'Invalid project state JSON on server.' });
        }
    });
});

// Endpoint POST /api/project/export: Pack project state and assets into a ZIP
app.post('/api/project/export', (req, res) => {
    try {
        const project = req.body;
        const projName = req.query.project || 'default';
        const { compositionsDir, assetsDir } = getProjectPaths(projName);
        
        if (!project) {
            return res.status(400).json({ error: 'Missing project payload.' });
        }
        
        const zip = new AdmZip();
        zip.addFile('project_state.json', Buffer.from(JSON.stringify(project, null, 2)));
        
        const tracks = project.tracks || [];
        tracks.forEach(track => {
            const src = track.src;
            if (!src) return;
            
            const fullPath = path.join(publicDir, src);
            if (fs.existsSync(fullPath) && fs.lstatSync(fullPath).isFile()) {
                let zipFolder = '';
                if (src.includes('/compositions/')) {
                    zipFolder = 'compositions';
                } else if (src.includes('/assets/')) {
                    zipFolder = 'assets';
                }
                zip.addLocalFile(fullPath, zipFolder);
            }
        });
        
        const buffer = zip.toBuffer();
        res.setHeader('Content-Type', 'application/zip');
        res.setHeader('Content-Disposition', `attachment; filename=htmlvr_project_${projName}_${Date.now()}.zip`);
        return res.send(buffer);
    } catch(err) {
        console.error("Export zip failed:", err);
        return res.status(500).json({ error: err.message });
    }
});

// Endpoint POST /api/project/import: Unpack project state and assets from a ZIP
app.post('/api/project/import', (req, res) => {
    const { zipData } = req.body;
    const projName = req.query.project || 'default';
    const { statePath, compositionsDir, assetsDir } = getProjectPaths(projName);
    
    if (!zipData) {
        return res.status(400).json({ error: 'Missing zipData payload.' });
    }
    
    try {
        const buffer = Buffer.from(zipData, 'base64');
        const zip = new AdmZip(buffer);
        const zipEntries = zip.getEntries();
        
        let projectJson = null;
        
        const stateEntry = zipEntries.find(entry => entry.entryName === 'project_state.json');
        if (stateEntry) {
            projectJson = JSON.parse(stateEntry.getData().toString('utf8'));
        }
        
        if (!projectJson) {
            return res.status(400).json({ error: 'Invalid ZIP archive: missing project_state.json.' });
        }
        
        zipEntries.forEach(entry => {
            if (entry.isDirectory) return;
            if (entry.entryName === 'project_state.json') return;
            
            const baseName = path.basename(entry.entryName);
            let destPath = '';
            if (entry.entryName.startsWith('compositions/')) {
                destPath = path.join(compositionsDir, baseName);
            } else if (entry.entryName.startsWith('assets/')) {
                destPath = path.join(assetsDir, baseName);
            } else {
                return;
            }
            
            const dir = path.dirname(destPath);
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }
            fs.writeFileSync(destPath, entry.getData());
        });
        
        if (projectJson && projectJson.tracks) {
            projectJson.tracks.forEach(track => {
                const baseName = path.basename(track.src);
                if (track.src.includes('/compositions/') || track.src.startsWith('compositions/')) {
                    track.src = `projects/${projName}/compositions/${baseName}`;
                } else if (track.src.includes('/assets/') || track.src.startsWith('assets/')) {
                    track.src = `projects/${projName}/assets/${baseName}`;
                }
            });
        }
        
        fs.writeFileSync(statePath, JSON.stringify(projectJson, null, 2));
        
        return res.json({ success: true, project: projectJson });
    } catch(err) {
        console.error("Import zip failed:", err);
        return res.status(500).json({ error: err.message });
    }
});

// Helper to ensure a directory exists dynamically
function ensureDir(dir) {
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
}

// Endpoint POST /api/project/new: Create new empty project
app.post('/api/project/new', (req, res) => {
    try {
        const projName = req.query.project || 'default';
        const { statePath, compositionsDir, assetsDir, deletedDir, deletedCompositionsDir, deletedAssetsDir } = getProjectPaths(projName);
        
        // Check if project already exists to avoid overwriting old projects
        if (fs.existsSync(statePath)) {
            return res.status(400).json({ error: `Project '${projName}' already exists. Please choose a different name.` });
        }
        
        // 1. Back up current state and dynamic files of this project
        deleteFolderRecursive(deletedDir);
        ensureDir(deletedCompositionsDir);
        ensureDir(deletedAssetsDir);

        if (fs.existsSync(statePath)) {
            fs.copyFileSync(statePath, path.join(deletedDir, 'project_state.json'));
        }

        if (fs.existsSync(compositionsDir)) {
            const compFiles = fs.readdirSync(compositionsDir);
            compFiles.forEach(file => {
                const fp = path.join(compositionsDir, file);
                if (fs.lstatSync(fp).isFile()) {
                    const dest = path.join(deletedCompositionsDir, file);
                    fs.renameSync(fp, dest);
                }
            });
        }
        
        if (fs.existsSync(assetsDir)) {
            const assetFiles = fs.readdirSync(assetsDir);
            assetFiles.forEach(file => {
                const fp = path.join(assetsDir, file);
                const dest = path.join(deletedAssetsDir, file);
                if (fs.existsSync(fp) && fs.lstatSync(fp).isFile()) {
                    fs.renameSync(fp, dest);
                }
            });
        }

        // 2. Set default project state
        const defaultState = {
            tracks: [],
            markers: [],
            trackConfigs: [
                { name: "Track 1" },
                { name: "Track 2" },
                { name: "Track 3" }
            ]
        };
        fs.writeFileSync(statePath, JSON.stringify(defaultState, null, 2));
        
        return res.json({ success: true, project: defaultState });
    } catch(err) {
        console.error("New project setup failed:", err);
        return res.status(500).json({ error: err.message });
    }
});

// Endpoint POST /api/project/undo: Restore project state and dynamic assets from Recycle Bin
app.post('/api/project/undo', (req, res) => {
    try {
        const projName = req.query.project || 'default';
        const { statePath, compositionsDir, assetsDir, deletedDir, deletedCompositionsDir, deletedAssetsDir } = getProjectPaths(projName);
        const backupStatePath = path.join(deletedDir, 'project_state.json');
        
        if (!fs.existsSync(backupStatePath)) {
            return res.status(400).json({ error: 'No undo backup available.' });
        }

        // Restore state file
        fs.copyFileSync(backupStatePath, statePath);
        const restoredState = JSON.parse(fs.readFileSync(statePath, 'utf8'));

        // Restore compositions files
        if (fs.existsSync(deletedCompositionsDir)) {
            const files = fs.readdirSync(deletedCompositionsDir);
            files.forEach(file => {
                const src = path.join(deletedCompositionsDir, file);
                const dest = path.join(compositionsDir, file);
                ensureDir(compositionsDir);
                fs.renameSync(src, dest);
            });
        }

        // Restore assets files
        if (fs.existsSync(deletedAssetsDir)) {
            const files = fs.readdirSync(deletedAssetsDir);
            files.forEach(file => {
                const src = path.join(deletedAssetsDir, file);
                const dest = path.join(assetsDir, file);
                ensureDir(assetsDir);
                fs.renameSync(src, dest);
            });
        }

        // Clear backup directory
        deleteFolderRecursive(deletedDir);

        return res.json({ success: true, project: restoredState });
    } catch (err) {
        console.error("Undo restore failed:", err);
        return res.status(500).json({ error: err.message });
    }
});

// Endpoint GET /api/project/has-backup: Check if there is an undo backup available
app.get('/api/project/has-backup', (req, res) => {
    const projName = req.query.project || 'default';
    const { deletedDir } = getProjectPaths(projName);
    const backupStatePath = path.join(deletedDir, 'project_state.json');
    return res.json({ hasBackup: fs.existsSync(backupStatePath) });
});

// Helper function to analyze 16-bit PCM WAV files
function analyzeWavFile(filePath) {
    try {
        const buffer = fs.readFileSync(filePath);
        let pos = 12;
        while (pos < buffer.length - 8) {
            const chunkId = buffer.toString('ascii', pos, pos + 4);
            const chunkSize = buffer.readUInt32LE(pos + 4);
            if (chunkId === 'data') {
                const dataStart = pos + 8;
                const dataEnd = Math.min(buffer.length, dataStart + chunkSize);
                const numChannels = buffer.readUInt16LE(22);
                const sampleRate = buffer.readUInt32LE(24);
                const bitsPerSample = buffer.readUInt16LE(34);
                
                if (bitsPerSample === 16) {
                    const bytesPerSample = 2;
                    const step = numChannels * bytesPerSample;
                    const totalSamples = Math.floor((dataEnd - dataStart) / step);
                    
                    const duration = totalSamples / sampleRate;
                    
                    let sumSq = 0;
                    let count = 0;
                    const rmsPoints = 20;
                    const samplesPerPoint = Math.floor(totalSamples / rmsPoints) || 1;
                    const loudnessGraph = [];
                    
                    let currentSumSq = 0;
                    let currentCount = 0;
                    
                    for (let i = 0; i < totalSamples; i++) {
                        const idx = dataStart + i * step;
                        if (idx >= dataEnd) break;
                        const val = buffer.readInt16LE(idx) / 32768.0;
                        sumSq += val * val;
                        count++;
                        
                        currentSumSq += val * val;
                        currentCount++;
                        if (currentCount >= samplesPerPoint) {
                            loudnessGraph.push(parseFloat(Math.sqrt(currentSumSq / currentCount).toFixed(4)));
                            currentSumSq = 0;
                            currentCount = 0;
                        }
                    }
                    
                    while (loudnessGraph.length < rmsPoints) {
                        loudnessGraph.push(0.0);
                    }
                    loudnessGraph.length = rmsPoints;
                    
                    const overallRms = Math.sqrt(sumSq / count || 1);
                    
                    return {
                        duration: parseFloat(duration.toFixed(3)),
                        rms: parseFloat(overallRms.toFixed(4)),
                        loudnessGraph
                    };
                }
                break;
            }
            pos += 8 + chunkSize;
        }
    } catch (err) {
        console.error("Wav analysis failed for:", filePath, err.message);
    }
    return null;
}

// 8. Endpoint GET /api/agent/state: Structured details for the AI Agent
app.get('/api/agent/state', (req, res) => {
    const projName = req.query.project || 'default';
    const { statePath, compositionsDir, assetsDir } = getProjectPaths(projName);
    const allowedExtensions = ['.html', '.mp4', '.webm', '.png', '.jpg', '.jpeg', '.gif', '.mp3', '.wav', '.ogg'];
    
    fs.readdir(compositionsDir, (err, files) => {
        if (err) {
            console.error('Error reading compositions:', err);
            return res.status(500).json({ error: 'Failed to read compositions directory.' });
        }
        
        const filteredFiles = files.filter(file => {
            const ext = path.extname(file).toLowerCase();
            return allowedExtensions.includes(ext);
        });
        
        const audioAnalysis = {};
        if (fs.existsSync(assetsDir)) {
            try {
                const assetFiles = fs.readdirSync(assetsDir);
                assetFiles.forEach(file => {
                    if (file.toLowerCase().endsWith('.wav')) {
                        const analysis = analyzeWavFile(path.join(assetsDir, file));
                        if (analysis) {
                            audioAnalysis[`projects/${projName}/assets/${file}`] = analysis;
                        }
                    }
                });
            } catch (scanErr) {
                console.error('Error scanning assets:', scanErr);
            }
        }
        
        let projectState = { tracks: [], markers: [] };
        if (fs.existsSync(statePath)) {
            try {
                projectState = JSON.parse(fs.readFileSync(statePath, 'utf8'));
            } catch (e) {
                console.error('Error parsing project state:', e);
            }
        }
        
        return res.json({
            project: projectState,
            files: filteredFiles,
            audioAnalysis
        });
    });
});

// 9. Endpoint POST /api/agent/trigger: Write trigger file to wake up IDE agent
app.post('/api/agent/trigger', (req, res) => {
    const triggerPath = path.join(tempDir, 'agent_trigger.txt');
    const projName = req.query.project || 'default';
    try {
        fs.writeFileSync(triggerPath, projName);
        console.log(`Agent trigger file successfully created for project: ${projName}`);
        return res.json({ success: true });
    } catch (err) {
        console.error("Failed to create agent trigger file:", err);
        return res.status(500).json({ error: "Failed to trigger agent." });
    }
});

// 10. Endpoint POST /api/download-image: Download a Gemini-generated image via Puppeteer
// This bypasses 403 errors on lh3.googleusercontent.com/rd-gg-dl/ URLs that Python
// HTTP clients cannot handle due to Google's Storage Access API requirements.
app.post('/api/download-image', async (req, res) => {
    const { image_url, save_path, all_cookies, fife_cookies, detailed_cookies } = req.body;
    if (!image_url || !save_path) {
        return res.status(400).json({ error: 'Missing image_url or save_path' });
    }

    console.log(`[ImageDL] Puppeteer download request: ${image_url.substring(0, 80)}...`);

    let browser = null;
    try {
        browser = await puppeteer.launch({
            headless: true,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-web-security',
                '--disable-features=IsolateOrigins,site-per-process',
                '--allow-running-insecure-content',
                '--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            ],
        });

        const page = await browser.newPage();
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

        // Inject Google auth cookies so Chrome has authenticated context
        const cookiesToSet = [];

        if (detailed_cookies && typeof detailed_cookies === 'object') {
            // Replicate the exact cookie jar from Yandex Browser profiles with original domains
            for (const [host, cookieDict] of Object.entries(detailed_cookies)) {
                for (const [name, value] of Object.entries(cookieDict)) {
                    if (name.startsWith('__Host-')) {
                        cookiesToSet.push({ name, value, url: `https://${host.replace(/^\./, '')}`, secure: true, path: '/' });
                    } else if (name.startsWith('__Secure-')) {
                        cookiesToSet.push({ name, value, domain: host, path: '/', secure: true });
                    } else {
                        cookiesToSet.push({ name, value, domain: host, path: '/' });
                    }
                }
            }
        } else {
            // Fallback to old behavior if detailed_cookies is missing
            if (all_cookies && typeof all_cookies === 'object') {
                for (const [name, value] of Object.entries(all_cookies)) {
                    if (name.startsWith('__Host-')) {
                        cookiesToSet.push({ name, value, url: 'https://gemini.google.com', secure: true, path: '/' });
                    } else if (name.startsWith('__Secure-')) {
                        cookiesToSet.push({ name, value, domain: '.google.com', path: '/', secure: true });
                    } else {
                        cookiesToSet.push({ name, value, domain: '.google.com', path: '/' });
                    }
                }
            }
            if (fife_cookies && typeof fife_cookies === 'object') {
                for (const [host, cookieDict] of Object.entries(fife_cookies)) {
                    const domain = host;
                    for (const [name, value] of Object.entries(cookieDict)) {
                        if (name.startsWith('__Host-')) {
                            cookiesToSet.push({ name, value, url: `https://${domain.replace(/^\./, '')}`, secure: true, path: '/' });
                        } else if (name.startsWith('__Secure-')) {
                            cookiesToSet.push({ name, value, domain: domain, path: '/', secure: true });
                        } else {
                            cookiesToSet.push({ name, value, domain: domain, path: '/' });
                        }
                    }
                }
            }
        }


        if (cookiesToSet.length > 0) {
            await page.setCookie(...cookiesToSet);
            console.log(`[ImageDL] Injected ${cookiesToSet.length} cookies into Puppeteer`);
        }

        // Navigate to gemini.google.com to establish context (sets additional session cookies)
        try {
            await page.goto('https://gemini.google.com/', {
                waitUntil: 'domcontentloaded',
                timeout: 15000,
            });
        } catch (navErr) {
            console.warn('[ImageDL] Navigation to gemini.google.com timed out (non-fatal):', navErr.message);
        }

        // Now follow the image URL redirect chain using page.goto (top-level navigations)
        // Chrome naturally handles the redirects and attaches Lax/Secure cookies (COMPASS) properly.
        const targetUrl = image_url.includes('/gg-dl/') && !image_url.includes('?alr=yes')
            ? (image_url.includes('=s1024-rj') ? image_url + '?alr=yes' : image_url + '=s1024-rj?alr=yes')
            : image_url;

        console.log(`[ImageDL] Starting Puppeteer navigation chain from: ${targetUrl.substring(0, 80)}`);



        // --- Hop 1 ---
        console.log('[ImageDL] Hop 1: page.goto to targetUrl...');
        let r1 = await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
        if (r1.status() !== 200) {
            throw new Error(`Hop 1 failed with status: ${r1.status()}`);
        }
        
        let contentType = r1.headers()['content-type'] || '';
        let hops = 1;
        let finalBuffer = null;

        if (contentType.startsWith('text/plain')) {
            const url1 = (await page.evaluate(() => document.body.innerText)).trim();
            console.log(`[ImageDL] Hop 1 redirect URL: ${url1.substring(0, 80)}`);

            // --- Hop 2 ---
            console.log('[ImageDL] Hop 2: page.goto to url1...');
            let r2 = await page.goto(url1, { waitUntil: 'domcontentloaded', timeout: 30000 });
            if (r2.status() !== 200) {
                throw new Error(`Hop 2 failed with status: ${r2.status()}`);
            }

            contentType = r2.headers()['content-type'] || '';
            hops = 2;

            if (contentType.startsWith('text/plain')) {
                const url2 = (await page.evaluate(() => document.body.innerText)).trim();
                console.log(`[ImageDL] Hop 2 redirect URL: ${url2.substring(0, 80)}`);

                // --- Hop 3 ---
                console.log('[ImageDL] Hop 3: page.goto to url2...');
                let r3 = await page.goto(url2, { waitUntil: 'networkidle0', timeout: 30000 });
                if (r3.status() !== 200) {
                    throw new Error(`Hop 3 failed with status: ${r3.status()}`);
                }

                contentType = r3.headers()['content-type'] || 'image/png';
                hops = 3;

                console.log('[ImageDL] Getting buffer from Hop 3 response...');
                finalBuffer = await r3.buffer();
            } else {
                // Hop 2 returned binary data
                console.log('[ImageDL] Getting buffer from Hop 2 response...');
                finalBuffer = await r2.buffer();
            }
        } else {
            // Hop 1 returned binary data
            console.log('[ImageDL] Getting buffer from Hop 1 response...');
            finalBuffer = await r1.buffer();
        }

        if (!finalBuffer || finalBuffer.length === 0) {
            throw new Error('Downloaded image buffer is empty.');
        }

        const result = { success: true, data: finalBuffer, contentType, hops };


        // Save the image to disk
        const imgBuffer = Buffer.from(result.data);
        const dir = path.dirname(save_path);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(save_path, imgBuffer);

        const ext = result.contentType.includes('png') ? 'png' : 'jpg';
        console.log(`[ImageDL] SUCCESS: Saved ${imgBuffer.length} bytes (${result.contentType}) to ${save_path} via ${result.hops} hops`);

        return res.json({
            success: true,
            path: save_path,
            size: imgBuffer.length,
            content_type: result.contentType,
            hops: result.hops,
        });

    } catch (err) {
        console.error('[ImageDL] Puppeteer error:', err);
        return res.status(500).json({ error: 'Puppeteer error', message: err.message });
    } finally {
        if (browser) {
            try { await browser.close(); } catch (e) {}
        }
    }
});

// Start Server Listen loop
const server = app.listen(PORT, () => {
    console.log(`HtmlVR Web Rendering Server successfully mounted and listening on: http://localhost:${PORT}`);
    startInpaintDaemon();
});
server.timeout = 0; // Disable connection connection timeout for long render jobs
server.keepAliveTimeout = 0; // Disable keep-alive timeout

// Spawn/Kill hot inpaint service daemon
const { spawn } = require('child_process');
function startInpaintDaemon() {
    const daemonScript = path.join(__dirname, 'inpaint_service.py');
    console.log(`[Daemon] Spawning inpaint daemon: python "${daemonScript}" --port 5050`);
    
    inpaintDaemonProcess = spawn('python', [daemonScript, '--port', '5050']);
    
    inpaintDaemonProcess.stdout.on('data', (data) => {
        console.log(`[Inpaint Daemon STDOUT]: ${data.toString().trim()}`);
    });
    
    inpaintDaemonProcess.stderr.on('data', (data) => {
        console.error(`[Inpaint Daemon STDERR]: ${data.toString().trim()}`);
    });
    
    inpaintDaemonProcess.on('close', (code) => {
        console.log(`[Inpaint Daemon] Process exited with code ${code}`);
        inpaintDaemonProcess = null;
    });
}

function cleanUpDaemon() {
    if (inpaintDaemonProcess) {
        console.log('[Daemon] Killing inpaint daemon process...');
        try {
            inpaintDaemonProcess.kill('SIGINT');
        } catch (e) {
            console.error('[Daemon] Error killing daemon process:', e);
        }
        inpaintDaemonProcess = null;
    }
}

process.on('exit', cleanUpDaemon);
process.on('SIGINT', () => {
    cleanUpDaemon();
    process.exit(0);
});
process.on('SIGTERM', () => {
    cleanUpDaemon();
    process.exit(0);
});