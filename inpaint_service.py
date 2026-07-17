
import sys
import types

# 1. Python 3.13 Compatibility Mock for imghdr (Must occur before importing iopaint)
m = types.ModuleType('imghdr')
m.what = lambda f, h=None: 'png'
sys.modules['imghdr'] = m

import argparse
import json
import traceback
from http.server import BaseHTTPRequestHandler, HTTPServer

import cv2
import numpy as np
from iopaint.model_manager import ModelManager
from iopaint.schema import InpaintRequest

# 2. Startup Model Loading (Held globally in hot memory)
print("[Inpaint Daemon] Initializing and loading LaMa model on CPU...", flush=True)
model = ModelManager(name='lama', device='cpu')
print("[Inpaint Daemon] Model loaded and ready.", flush=True)

# 3. Unicode-Safe Image IO Wrappers for Windows Path compatibility
import os

def unicode_imread(path, flags=cv2.IMREAD_COLOR):
    try:
        nparr = np.fromfile(str(path), dtype=np.uint8)
        return cv2.imdecode(nparr, flags)
    except Exception as e:
        print(f"Error reading path {path} with unicode_imread: {e}", file=sys.stderr)
        return None

def unicode_imwrite(path, img, params=None):
    try:
        ext = os.path.splitext(str(path))[1]
        if not ext:
            ext = '.png'
        is_success, im_buf_arr = cv2.imencode(ext, img, params)
        if is_success:
            im_buf_arr.tofile(str(path))
            return True
        return False
    except Exception as e:
        print(f"Error writing path {path} with unicode_imwrite: {e}", file=sys.stderr)
        return False

class InpaintHTTPHandler(BaseHTTPRequestHandler):
    
    def _send_json(self, status_code, payload):
        """Helper to send structured JSON responses."""
        self.send_response(status_code)
        self.send_header('Content-Type', 'application/json')
        self.end_headers()
        self.wfile.write(json.dumps(payload).encode('utf-8'))

    def do_GET(self):
        # GET /health endpoint
        if self.path == '/health':
            self._send_json(200, {"status": "healthy"})
        else:
            self._send_json(404, {"error": "Not Found"})

    def do_POST(self):
        # POST /inpaint endpoint
        if self.path == '/inpaint':
            content_length = int(self.headers.get('Content-Length', 0))
            post_data = self.rfile.read(content_length)
            
            try:
                req_data = json.loads(post_data.decode('utf-8'))
            except Exception as e:
                self._send_json(400, {"error": f"Invalid JSON body: {str(e)}"})
                return
 
            # Extract data from request payload
            image_path = req_data.get('image_path')
            mask_path = req_data.get('mask_path')
            output_path = req_data.get('output_path')
            dilation = req_data.get('dilation')

            # Validate mandatory fields
            if not image_path or not mask_path or not output_path:
                self._send_json(400, {
                    "error": "Missing required fields. 'image_path', 'mask_path', and 'output_path' must be provided."
                })
                return

            try:
                # a. Load the source image
                image = unicode_imread(image_path)
                if image is None:
                    raise FileNotFoundError(f"Source image could not be loaded from path: {image_path}")

                # b. Load the mask image in grayscale
                mask = unicode_imread(mask_path, cv2.IMREAD_GRAYSCALE)
                if mask is None:
                    raise FileNotFoundError(f"Mask image could not be loaded from path: {mask_path}")

                # c. Perform OpenCV mask dilation if requested
                if dilation is not None and isinstance(dilation, int) and dilation > 0:
                    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (dilation * 2 + 1, dilation * 2 + 1))
                    mask = cv2.dilate(mask, kernel, iterations=1)

                # d. Create InpaintRequest schema instance
                config = InpaintRequest(
                    ldm_steps=20,
                    ldm_sampler="ddim",
                    zssamplesteps=10,
                    sd_steps=20,
                    sd_sampler="uni_pc",
                    sd_mask_blur=4,
                    sd_strength=0.75,
                    sd_guidance_scale=7.5,
                    hd_strategy="Crop",
                    hd_strategy_crop_margin=128,
                    hd_strategy_crop_trigger_size=2048,
                    hd_strategy_resize_limit=2048,
                    prompt="",
                    negative_prompt="",
                    use_crop=False,
                    model_name="lama",
                )

                # e. Perform neural inpainting execution
                image_rgb = cv2.cvtColor(image, cv2.COLOR_BGR2RGB)
                res_np = model(image_rgb, mask, config)

                # f. Save output file to disk (converting back to BGR for cv2)
                res_bgr = cv2.cvtColor(res_np, cv2.COLOR_RGB2BGR)
                write_success = unicode_imwrite(output_path, res_bgr)
                if not write_success:
                    raise IOError(f"Failed to write output image to file path: {output_path}")

                # Return successful response
                self._send_json(200, {"success": True})

            except Exception as e:
                # Print traceback to stderr and return 500 error payload
                traceback.print_exc(file=sys.stderr)
                self._send_json(500, {"error": str(e)})
        else:
            self._send_json(404, {"error": "Not Found"})


def run_server():
    parser = argparse.ArgumentParser(description="Inpaint Service Daemon (LaMa CPU)")
    parser.add_argument('--port', type=int, default=5050, help="Port to run the HTTP server on (default: 5050)")
    args = parser.parse_args()

    server_address = ('', args.port)
    httpd = HTTPServer(server_address, InpaintHTTPHandler)
    
    # 3. Formatted startup logging
    print(f"[Inpaint Daemon] Listening on http://localhost:{args.port}...", flush=True)
    
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n[Inpaint Daemon] Shutting down gracefully...", flush=True)
        httpd.server_close()


if __name__ == '__main__':
    run_server()