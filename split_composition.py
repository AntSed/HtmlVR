import sys, re
from pathlib import Path

def split_comp(inp, out_dir=None):
    p = Path(inp)
    if not p.exists(): return print(f"Error: {inp} not found.")
    content = p.read_text(encoding="utf-8")
    m = re.search(r'(function render\(\)\s*\{(.*?)\n\s*requestAnimationFrame)', content, re.DOTALL)
    if not m: return print("Error parsing render function.")
    full_fn, body = m.group(1) + "(render);\n        }", m.group(2)
    blocks = re.sub(r'\n\s*\n\s*//', "\n===SPLIT===\n//", body).split("===SPLIT===")
    if len(blocks) <= 1: return print("No multiple blocks detected.")
    
    first_lines = blocks[0].split('\n')
    comment_idx = next((i for i, l in enumerate(first_lines) if l.strip().startswith("//")), len(first_lines))
    header = "\n".join(first_lines[:comment_idx]).strip()
    blocks[0] = "\n".join(first_lines[comment_idx:])
    
    out = Path(out_dir) if out_dir else p.parent
    for idx, block in enumerate(blocks):
        if not block.strip(): continue
        first_line = block.strip().split('\n')[0].strip()
        title = first_line.replace('//', '').strip() if first_line.startswith('//') else f"block_{idx}"
        slug = re.sub(r'[^\w\s]', '', title.lower())
        slug_words = [w for w in slug.split() if w not in ['draw', 'рисовать', 'рисуем', 'анимация', 'слайд', 'shaking', 'floating', 'vibrating', 'small', 'glowing', 'circles', 'along', 'text', 'goofy', 'face']]
        slug = '_'.join(slug_words[:3]) or f"block_{idx}"
        
        new_render = f"function render() {{\n            {header}\n            {block.strip()}\n            requestAnimationFrame(render);\n        }}"
        new_content = content.replace(full_fn, new_render)
        new_content = re.sub(r'tl\.fromTo\("#container".*?\);', 'tl.to({}, { duration: 10 });', new_content)
        out_path = out / f"{p.stem}_{slug}.html"
        out_path.write_text(new_content, encoding="utf-8")
        print(f"Created: {out_path}")

if __name__ == "__main__":
    if len(sys.argv) < 2: print("Usage: python split_composition.py <input_file>")
    else: split_comp(sys.argv[1], sys.argv[2] if len(sys.argv) > 2 else None)
