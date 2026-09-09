"""Serve only files actually attached/linked in a conversation, through either RPC transport."""
import base64
import hashlib
import json
import mimetypes
import os
import re
from pathlib import Path
from urllib.parse import unquote, urlparse
from html.parser import HTMLParser
from html import escape

LIMIT = 20 * 1024 * 1024
THUMB_DIR = os.path.expanduser('~/tasks/.dispatch/thumbs')
THUMB_PX = 320
EXTENSIONS = {'.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.pdf', '.html', '.htm', '.md', '.txt', '.csv', '.json', '.mp4', '.webm', '.mp3', '.wav', '.docx', '.xlsx', '.pptx', '.zip'}


def portable_html(content, parent):
    """Only embed raster images inside the artifact directory, with a total byte budget."""
    class Embed(HTMLParser):
        def __init__(self): super().__init__(convert_charrefs=False); self.parts=[]; self.used=0
        def handle_starttag(self, tag, attrs):
            if tag != 'img': self.parts.append(self.get_starttag_text()); return
            result=[]
            for k,v in attrs:
                if k=='src' and v and not urlparse(v).scheme and not v.startswith(('/', '//')):
                    path=(parent/unquote(v.split('#')[0])).resolve()
                    if path.is_relative_to(parent.resolve()) and path.suffix.lower() in {'.png','.jpg','.jpeg','.gif','.webp'} and path.is_file():
                        if self.used+path.stat().st_size<=LIMIT:
                            data=path.read_bytes();self.used+=len(data)
                            mime='image/jpeg' if data.startswith(b'\xff\xd8\xff') else mimetypes.guess_type(path.name)[0]
                            v=f'data:{mime};base64,'+base64.b64encode(data).decode()
                result.append(k if v is None else f'{k}="{escape(v, quote=True)}"')
            self.parts.append('<'+tag+' '+' '.join(result)+'>')
        def handle_endtag(self,tag):self.parts.append(f'</{tag}>')
        def handle_data(self,data):self.parts.append(data)
        def handle_entityref(self,name):self.parts.append('&'+name+';')
        def handle_charref(self,name):self.parts.append('&#'+name+';')
        def handle_comment(self,data):self.parts.append('<!--'+data+'-->')
        def handle_decl(self,data):self.parts.append('<!'+data+'>')
    parser=Embed();parser.feed(content);return ''.join(parser.parts)


# A picture named by path alone in a message: a phone photo the reply box attached, a screenshot
# the agent points at. Only image suffixes, only absolute or ~ paths.
BARE_IMAGE = re.compile(r'(?<![\w/(\[])(?:/|~/)[^\s"\'()<>\[\]]+?\.(?:png|jpe?g|gif|webp)\b', re.I)


def local_path(value, cwd):
    value = unquote(value.strip().strip('<>'))
    if value.startswith('file://'): value = urlparse(value).path
    if re.match(r'^[a-zA-Z][\w+.-]*:', value): return None
    value = re.sub(r':\d+(?::\d+)?$', '', value.split('#')[0])
    if not value or Path(value).suffix.lower() not in EXTENSIONS: return None
    return os.path.abspath(os.path.expanduser(value) if value.startswith(('~', '/')) else os.path.join(cwd or os.getcwd(), value))


def scan(ref):
    """Ignore tool arguments/system content. A tool mentioning a secret is not an attachment."""
    found = {}
    def add(value, ts, embedded=False, label=''):
        if not isinstance(value, str): return
        if embedded:
            if not re.match(r'^data:(image/(?:png|jpeg|gif|webp)|application/pdf);base64,', value): return
            key = 'embedded:' + hashlib.sha256(value.encode()).hexdigest()[:24]
            found.setdefault(key, {'id': key, 'path': '', 'name': label or '会话图片', 'ts': ts, '_data': value})
        else:
            path = local_path(value, ref.get('cwd', ''))
            if path:
                key = hashlib.sha256(path.encode()).hexdigest()[:24]
                found.setdefault(key, {'id': key, 'path': path, 'name': label or Path(path).name, 'ts': ts, '_real': os.path.realpath(path)})
    def text(s, ts):
        for m in re.finditer(r'!?\[([^\]\n]*)\]\(\s*(<[^>]+>|[^\s)]+)(?:\s+"[^"]*")?\s*\)', s): add(m[2], ts, label=m[1])
        for m in re.finditer(r'<image\b[^>]*\bpath=["\']([^"\']+)["\']', s): add(m[1], ts)
        for m in re.finditer(r'^## [^\n]+?:\s+((?:/|~/)[^\n]+)$', s, re.M): add(m[1], ts)
        for m in BARE_IMAGE.finditer(s): add(m[0], ts)
    try:
        with open(ref['path'], encoding='utf-8', errors='replace') as f:
            for line in f:
                try: row = json.loads(line)
                except (ValueError, TypeError): continue
                ts = row.get('timestamp', '')
                if ref['agent'] == 'codex':
                    m = row.get('payload') or {}
                    if row.get('type') != 'response_item' or m.get('type') != 'message': continue
                else:
                    if row.get('type') not in ('user', 'assistant', 'message'): continue
                    m = row.get('message') or {}
                if m.get('role', row.get('type')) not in ('user', 'assistant'): continue
                content = m.get('content') or []
                if isinstance(content, str): text(content, ts); continue
                blocks = []
                for b in content:
                    if not isinstance(b, dict): continue
                    blocks.append(b)
                    if b.get('type') == 'tool_result' and isinstance(b.get('content'), list):
                        blocks.extend(x for x in b['content'] if isinstance(x, dict))
                for b in blocks:
                    if b.get('type') in ('text', 'input_text', 'output_text'): text(b.get('text', ''), ts)
                    if b.get('type') in ('image', 'input_image', 'image_url'):
                        src = b.get('source') or {}
                        url = b.get('image_url', b.get('url', ''))
                        if isinstance(url, dict): url = url.get('url', '')
                        if src.get('type') == 'base64': url = f"data:{src.get('media_type', 'image/png')};base64,{src.get('data', '')}"
                        add(url, ts, embedded=url.startswith('data:'))
    except (OSError, UnicodeError): pass
    return list(found.values())


def catalog(ref):
    return [{**{k: v for k, v in a.items() if not k.startswith('_')},
             'mime': a.get('_data', '').split(';')[0][5:] if a.get('_data') else mimetypes.guess_type(a['path'])[0] or 'application/octet-stream',
             'exists': bool(a.get('_data')) or Path(a.get('_real', '')).is_file()} for a in scan(ref)]


def read(ref, key):
    assets = scan(ref)
    wanted = local_path(key, ref.get('cwd', ''))
    asset = next((a for a in assets if a['id'] == key or (wanted and a['path'] == wanted)), None)
    if not asset: raise ValueError('文件未附加或链接在此会话中')
    if asset.get('_data'):
        mime, encoded = asset['_data'].split(';base64,', 1)
        if len(encoded) > LIMIT * 4 // 3 + 4: raise ValueError('附件超过 20 MB，请在原应用打开')
        data = base64.b64decode(encoded, validate=True); mime = mime[5:]
    else:
        path = Path(asset['_real'])
        if not path.is_file(): raise ValueError('文件已移动或临时附件已被清理')
        if path.stat().st_size > LIMIT: raise ValueError('附件超过 20 MB，请在原应用打开')
        data = path.read_bytes()
        mime = mimetypes.guess_type(path.name)[0] or 'application/octet-stream'
        # Screenshots from some macOS APIs have a PNG suffix but JPEG bytes.
        if data.startswith(b'\xff\xd8\xff'): mime = 'image/jpeg'
        elif data.startswith(b'\x89PNG\r\n'): mime = 'image/png'
    if len(data) > LIMIT: raise ValueError('附件超过 20 MB，请在原应用打开')
    content = data.decode('utf-8', errors='replace') if mime.startswith('text/') or mime in ('application/json', 'image/svg+xml') else None
    if mime == 'text/html' and asset.get('_real'): content = portable_html(content, Path(asset['_real']).parent)
    return {'name': asset['name'], 'path': asset['path'], 'mime': mime, 'size': len(data),
            'data': base64.b64encode(data).decode(), 'text': content}


def _thumb_bytes(data, key):
    """A ≤320 px JPEG of an image, made once with macOS `sips` and kept on disk. Falls back to
    the original bytes when sips is unavailable or the image is already small."""
    import subprocess, tempfile
    os.makedirs(THUMB_DIR, exist_ok=True)
    out = os.path.join(THUMB_DIR, key.replace(':', '_') + '.jpg')
    if os.path.isfile(out):
        return open(out, 'rb').read(), 'image/jpeg'
    if len(data) < 40 * 1024:
        return data, None
    with tempfile.NamedTemporaryFile(suffix='.png', delete=False) as f:
        f.write(data); src = f.name
    try:
        r = subprocess.run(['sips', '-s', 'format', 'jpeg', '-s', 'formatOptions', '70', '-Z', str(THUMB_PX), src, '--out', out], capture_output=True, timeout=15)
        if r.returncode == 0 and os.path.isfile(out):
            return open(out, 'rb').read(), 'image/jpeg'
    except Exception:
        pass
    finally:
        try: os.remove(src)
        except OSError: pass
    return data, None


def thumbs(ref):
    """Every image attached in a conversation, as small thumbnails, in one pass over the transcript.
    The app calls this once per session instead of one process per picture."""
    out = {}
    for a in scan(ref):
        try:
            if a.get('_data'):
                mime, encoded = a['_data'].split(';base64,', 1); mime = mime[5:]
                if not mime.startswith('image/'): continue
                data = base64.b64decode(encoded, validate=True)
            else:
                path = Path(a.get('_real', ''))
                mime = mimetypes.guess_type(path.name)[0] or ''
                if not mime.startswith('image/') or not path.is_file() or path.stat().st_size > LIMIT: continue
                data = path.read_bytes()
                if data.startswith(b'\xff\xd8\xff'): mime = 'image/jpeg'
            if mime in ('image/svg+xml', 'image/gif'):
                small, m2 = data, None
            else:
                small, m2 = _thumb_bytes(data, a['id'])
            out[a['id']] = {'name': a['name'], 'mime': m2 or mime, 'size': len(data), 'data': base64.b64encode(small).decode()}
        except Exception:
            continue
    return out
