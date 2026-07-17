import os, sys, subprocess, tempfile

def clean_watermark(image_path):
    base_dir = os.path.dirname(os.path.abspath(__file__))
    mask_tmpl = os.path.join(base_dir, "public", "assets", "star_mask_perfect.png")
    if not os.path.exists(image_path) or not os.path.exists(mask_tmpl):
        return False
    try:
        import cv2, numpy as np
        img = cv2.imread(image_path)
        h, w, _ = img.shape
        
        # Mathematically scale the verified widescreen coordinates ([1200:1400, 2450:2680] of 2816x1536)
        scale_x = w / 2816.0
        scale_y = h / 1536.0
        y1 = int(1200 * scale_y)
        y2 = int(1400 * scale_y)
        x1 = int(2450 * scale_x)
        x2 = int(2680 * scale_x)
        
        full_mask = np.zeros((h, w), dtype=np.uint8)
        full_mask[y1:y2, x1:x2] = 255
        print(f"[Watermark] Generated scaled rectangle mask: [{y1}:{y2}, {x1}:{x2}]")
        try:
            with tempfile.TemporaryDirectory() as td:
                tmp_mask = os.path.join(td, "mask.png")
                cv2.imwrite(tmp_mask, full_mask)
                
                # Try sending request to hot CPU LaMa daemon first
                try:
                    import urllib.request, json
                    req_data = {
                        "image_path": os.path.abspath(image_path),
                        "mask_path": os.path.abspath(tmp_mask),
                        "output_path": os.path.abspath(image_path)
                    }
                    req = urllib.request.Request(
                        "http://127.0.0.1:5050/inpaint",
                        data=json.dumps(req_data).encode("utf-8"),
                        headers={"Content-Type": "application/json"}
                    )
                    with urllib.request.urlopen(req, timeout=30.0) as res:
                        resp = json.loads(res.read().decode("utf-8"))
                        if resp.get("success"):
                            print(f"[Watermark] Cleaned with hot iopaint daemon: {os.path.basename(image_path)}")
                            return True
                        else:
                            raise ValueError(f"Daemon error: {resp.get('error')}")
                except Exception as de:
                    print(f"[Watermark Warning] Hot daemon failed ({de}), falling back to offline batch CLI...")
                    code = f"import sys, types; m=types.ModuleType('imghdr'); m.what=lambda f,h=None: 'png'; sys.modules['imghdr']=m; from iopaint.batch_processing import batch_inpaint; from pathlib import Path; batch_inpaint('lama', 'cpu', Path({repr(image_path)}), Path({repr(tmp_mask)}), Path({repr(os.path.dirname(image_path))}))"
                    subprocess.run([sys.executable, "-c", code], capture_output=True, check=True)
                    print(f"[Watermark] Cleaned with iopaint (offline CLI): {os.path.basename(image_path)}")
                    return True
        except Exception as e:
            print(f"[Watermark Warning] Neural inpaint failed ({e}), using OpenCV fallback...")
            inpainted = cv2.inpaint(img, full_mask, 5, cv2.INPAINT_NS)
            cv2.imwrite(image_path, inpainted)
            print(f"[Watermark] Cleaned with OpenCV: {os.path.basename(image_path)}")
            return True
    except Exception as e:
        print(f"[Watermark Error] Failed to clean watermark: {e}")
        return False
