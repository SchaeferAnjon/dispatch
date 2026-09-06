"""Local, explainable instruction audit. No LLM requests or credentials are sent."""
import difflib
import hashlib
import json
import os
import re
import tempfile
import time
from pathlib import Path

BEGIN = '<!-- BEGIN DISPATCH GLOBAL RULES'
END = '<!-- END DISPATCH GLOBAL RULES -->'
BLOCK = re.compile(re.escape(BEGIN) + r'.*?' + re.escape(END), re.S)
SOURCES = {'codex': 'https://learn.chatgpt.com/docs/agent-configuration/agents-md', 'claude': 'https://code.claude.com/docs/en/memory'}


def digest(s): return hashlib.sha256(s.encode()).hexdigest()
def text(p):
    try:
        if p.stat().st_size > 1024 * 1024: raise ValueError('规则文件超过 1 MB，需先缩减')
        return p.read_text(encoding='utf-8')
    except FileNotFoundError: return ''


def references(content, parent):
    # Code samples are not live imports. Both @imports and explicit Markdown references are reported.
    content = re.sub(r'```.*?```|~~~.*?~~~', '', content, flags=re.S)
    values = re.findall(r'(?<![\w])@((?:~/|/|\.?\.?/)?[^\s`<>]+\.md)', content)
    values += re.findall(r'\[[^\]]+\]\(<?([^\s)>]+\.md)(?:#[^\s)>]*)?>?\)', content)
    values += re.findall(r'<!-- BEGIN DISPATCH GLOBAL RULES[^\n]*source:([^\n]+?) -->', content)
    result = []
    for v in values:
        if '://' in v: continue
        p = Path(os.path.expanduser(v)) if v.startswith(('~', '/')) else parent / v
        # Normalize without discarding a symlink: display both the logical and actual location.
        p = Path(os.path.abspath(p))
        if p not in result: result.append(p)
    return result


def inventory(home, overrides=None, project=None):
    home = Path(home); overrides = overrides or {}
    codex = Path(os.environ.get('CODEX_HOME', str(home / '.codex'))) if home == Path.home() else home / '.codex'
    claude = Path(os.environ.get('CLAUDE_CONFIG_DIR', str(home / '.claude'))) if home == Path.home() else home / '.claude'
    candidates = [('shared', home / '.agents/rules/GLOBAL.md'), ('codex', codex / 'AGENTS.override.md'), ('codex', codex / 'AGENTS.md'), ('claude', claude / 'CLAUDE.md'), ('pi', home / '.pi/agent/AGENTS.md'), ('zcode', home / '.zcode/AGENTS.md'), ('gemini', home / '.gemini/GEMINI.md'), ('opencode', home / '.config/opencode/AGENTS.md')]
    candidates += [('claude', p) for p in sorted((claude / 'rules').glob('**/*.md'))][:80]
    if project:
        root = Path(project)
        candidates += [('codex', root / 'AGENTS.md'), ('codex', root / 'AGENTS.override.md'), ('claude', root / 'CLAUDE.md')]
        candidates += [('claude', p) for p in sorted((root / '.claude/rules').glob('**/*.md'))][:80]
    docs = {}
    def visit(agent, p, via='', active=True, chain=()):
        key = str(p)
        if len(docs) >= 120 or len(chain) > 10: return
        if key in docs:
            if agent not in docs[key]['agents']: docs[key]['agents'].append(agent)
            if via and via not in docs[key]['referenced_by']: docs[key]['referenced_by'].append(via)
            return
        real = p.resolve(); content = overrides.get(key, text(p))
        refs = references(content, p.parent)
        docs[key] = {'path': key, 'real_path': str(real), 'name': p.name, 'agents': [agent], 'exists': p.is_file(), 'active': active, 'content': content, 'hash': digest(content), 'bytes': len(content.encode()), 'lines': len(content.splitlines()), 'references': [str(x) for x in refs], 'referenced_by': [via] if via else [], 'managed': bool(BLOCK.search(content)), 'writable': os.access(real if real.exists() else real.parent, os.W_OK)}
        for r in refs: visit(agent, r, key, active, (*chain, key))
    for ag, p in candidates:
        if p.is_file() or (p.parent.exists() and p.name in ('AGENTS.md', 'CLAUDE.md', 'GEMINI.md')):
            visit(ag, p, active=not (ag == 'codex' and p.name == 'AGENTS.md' and bool(text(p.parent / 'AGENTS.override.md').strip())))
    models = []
    try:
        import tomllib
        cfg = tomllib.loads(text(codex / 'config.toml'))
        models.append({'agent': 'codex', 'model': cfg.get('model', ''), 'source': str(codex / 'config.toml'), 'limit': cfg.get('project_doc_max_bytes', 32768)})
    except (ValueError, ImportError): pass
    try:
        cfg = json.loads(text(claude / 'settings.json') or '{}')
        models.append({'agent': 'claude', 'model': cfg.get('model', ''), 'source': str(claude / 'settings.json')})
    except ValueError: pass
    return {'documents': list(docs.values()), 'models': models, 'sources': SOURCES, 'checked_at': time.time()}


def audit(inv, profile='auto', model=''):
    docs = inv['documents']; by_path = {d['path']: d for d in docs}; findings = []
    def add(kind, d, line, message, suggestion, other=None):
        findings.append({'kind': kind, 'path': d['path'], 'line': line, 'message': message, 'suggestion': suggestion, 'other': other})
    statements = {}; cross = {}
    for d in docs:
        if not d['exists'] and not d['content']: continue
        if not d['active']:
            add('scope', d, 1, '同层 AGENTS.override.md 非空，本文件不会作为该范围的 Codex 指令加载', '修改实际生效的 override 文件，或移除覆盖后再使用本文件。'); continue
        content = BLOCK.sub(lambda m: '\n' * m[0].count('\n'), d['content']) if d['managed'] else d['content']
        fence = False; heading = ''; seen = {}
        for n, raw in enumerate(content.splitlines(), 1):
            if raw.lstrip().startswith(('```', '~~~')): fence = not fence; continue
            if fence: continue
            if raw.startswith('#'): heading = raw.strip(); continue
            norm = re.sub(r'^[\s*+\-\d.)]+', '', raw).strip()
            if len(norm) < 16: continue
            if norm in seen: add('duplicate', d, n, f'与第 {seen[norm]} 行重复', '核对所属章节和适用条件；只合并同范围的规则。')
            seen[norm] = n
            for old in cross.get(norm, []):
                if old['real_path'] != d['real_path'] and (set(old['agents']) & set(d['agents']) or 'shared' in old['agents'] or 'shared' in d['agents']):
                    add('duplicate', d, n, '另一份适用文档包含相同规则', '核对范围；可保留一个来源并通过引用组织，托管副本不计为重复。', {'path': old['path'], 'line': old['line']})
            cross.setdefault(norm, []).append({**d, 'line': n})
            # Flag exact polarity pairs as candidates, never silently resolve policy choices.
            neg = bool(re.search(r'\b(?:never|do not|must not)\b|禁止|不得|不要', norm, re.I))
            positive = bool(re.search(r'\b(?:always|must)\b|必须|务必', norm, re.I))
            body = re.sub(r'\b(?:never|do not|must not|always|must)\b|禁止|不得|不要|必须|务必', '', norm, flags=re.I)
            body = re.sub(r'[\s。.!！,，;；:*`]+', '', body).lower()
            if len(body) >= 5 and (neg or positive):
                for prev in statements.get(body, []):
                    if prev['neg'] != neg and (set(prev['agents']) & set(d['agents']) or 'shared' in prev['agents'] or 'shared' in d['agents']):
                        add('conflict', d, n, '发现措辞相反的候选规则，需核对作用域和例外条件', '保留明确的适用条件及优先级，不能自动决定哪条政策正确。', {'path': prev['path'], 'line': prev['line']})
                statements.setdefault(body, []).append({'neg': neg, 'path': d['path'], 'line': n, 'agents': d['agents'], 'heading': heading})
            if re.search(r'(每次|始终|always).{0,15}(全仓|全部文件|all files)', norm, re.I): add('scope', d, n, '无条件要求读取所有文件，可能增加上下文和执行成本', '把适用场景写清楚；让 Agent 按当前任务选择需要读取的文件。')
        for ref in d['references']:
            if not by_path.get(ref, {}).get('exists'): add('reference', d, 1, f'引用不存在：{ref}', '修正引用或补齐文件，不要保留失效的入口。')
        if 'claude' in d['agents'] and d['lines'] > 200: add('size', d, 1, 'CLAUDE.md 超过官方建议的约 200 行', '把仅在特定场景需要的内容移入按路径加载的 rules 或技能；@import 本身不会减少加载量。')
        limit = next((m.get('limit', 32768) for m in inv['models'] if m['agent'] == 'codex'), 32768)
        if 'codex' in d['agents'] and d['bytes'] >= limit: add('size', d, 1, f'达到 Codex 配置中的 {limit} 字节文档预算', '缩减全局内容，为项目指令留出空间；预算包括合并后的项目文档。')
        if re.search(r'/(Users|home)/[^/\s]+/', content): add('portability', d, 1, '存在个人绝对路径', '面向多用户时改为用户目录、项目相对路径或可配置值；不要盲目替换代码示例。')
        if d['managed']:
            for block in BLOCK.findall(d['content']):
                match = re.search(r'hash:([0-9a-f]+) source:(.*?) -->', block)
                if match:
                    source = by_path.get(match[2]); expected = hashlib.sha256((source or {}).get('content', '').encode()).hexdigest()[:12]
                    # Existing Dispatch uses SHA256[:12]; validate against the source, not duplicate mirrors.
                    if source and match[1] != expected: add('sync', d, 1, '托管块版本与源文档不一致', '从唯一源文件重新同步，避免手改各个副本。')
    def walk(path, stack):
        if path in stack:
            d = by_path[path]; add('cycle', d, 1, '存在循环引用', '移除循环边，保持引用链单向。'); return
        if len(stack) >= 10: return
        for p in by_path.get(path, {}).get('references', []):
            if p in by_path: walk(p, (*stack, path))
    for d in docs: walk(d['path'], ())
    unique = {(x['kind'], x['path'], x['line'], x['message']): x for x in findings}
    family = profile if profile != 'auto' else ('claude' if 'claude' in model.lower() else 'codex' if re.search(r'gpt|codex|o[134]', model, re.I) else 'general')
    notes = ['本地静态检查；语义冲突仅列候选，不等同于完整的模型审查。', '将稳定偏好、任务触发条件、完成标准写清楚；避免把一次性任务写进全局规则。']
    if family == 'codex': notes.append('Codex：尊重 override 优先级与项目文档预算；保留工具、验证和交付约定，避免重复项目上下文。')
    elif family == 'claude': notes.append('Claude：共同约定放 CLAUDE.md，按文件范围的内容放 .claude/rules；引用用于组织内容，不会自动节省上下文。')
    else: notes.append('模型未识别或使用通用配置；不假设特定模型的能力，先检查结构、重复和引用。')
    return {'findings': list(unique.values()), 'profile': family, 'model': model, 'notes': notes}


def tidy(content):
    lines = content.splitlines(); result = []; fenced = False; managed = False
    for line in lines:
        if BEGIN in line: managed = True
        if line.lstrip().startswith(('```', '~~~')): fenced = not fenced
        if not fenced and not managed and result and line == result[-1] and re.match(r'^\s*[-*+]\s+\S', line): continue
        result.append(line)
        if END in line: managed = False
    return '\n'.join(result).rstrip('\n') + '\n'


def plan(home, path, content, profile='auto', model='', project=None):
    inv = inventory(home, project=project); docs = {d['path']: d for d in inv['documents']}
    if path not in docs: raise ValueError('文件未在当前作用范围或引用链中检测到')
    d = docs[path]
    if not content.strip(): raise ValueError('不能将指令文件保存为空')
    if BLOCK.findall(content) != BLOCK.findall(d['content']): raise ValueError('托管块由源文档生成，请修改其 source 文件')
    changes = {path: content}
    # Update only existing managed consumers of this exact source; do not create unused Agent homes.
    for other in inv['documents']:
        def replace(m):
            block = m[0]
            source = re.search(r'source:(.*?) -->', block)
            if not source or str(Path(source[1]).resolve()) != d['real_path']: return block
            h = hashlib.sha256(content.encode()).hexdigest()[:12]
            body = '@' + path + '\n' if re.search(r'^@' + re.escape(path) + r'\s*$', block, re.M) else content.rstrip() + '\n'
            return f'{BEGIN} hash:{h} source:{path} -->\n{body}{END}'
        new = BLOCK.sub(replace, other['content'])
        if new != other['content']: changes[other['path']] = new
    actual = {}
    for p,value in changes.items():
        real = docs[p]['real_path']
        if real in actual and actual[real][1] != value: raise ValueError('多个逻辑路径指向同一文件，但修改结果不同')
        actual.setdefault(real, (p,value))
    changes = {x['path']: actual[x['real_path']][1] for x in inv['documents'] if x['real_path'] in actual}
    future = inventory(home, changes, project=project)
    entries = [{'path': p, 'real_path': real, 'before': docs[p]['content'], 'after': value, 'hash': docs[p]['hash'], 'existed': docs[p]['exists'], 'diff': ''.join(difflib.unified_diff(docs[p]['content'].splitlines(True), value.splitlines(True), fromfile=p, tofile=p))} for real,(p,value) in actual.items() if value != docs[p]['content']]
    return {'changes': entries, 'hashes': {d['path']: d['hash'] for d in inv['documents']}, **audit(future, profile, model)}


def atomic_write(path, content):
    path = Path(path).resolve(); path.parent.mkdir(parents=True, exist_ok=True)
    fd, temp = tempfile.mkstemp(prefix='.dispatch-', dir=path.parent)
    try:
        with os.fdopen(fd, 'w', encoding='utf-8') as f: f.write(content)
        os.chmod(temp, path.stat().st_mode & 0o777 if path.exists() else 0o600)
        os.replace(temp, path)
    finally:
        if os.path.exists(temp): os.unlink(temp)


def apply(home, payload, project=None):
    import fcntl
    folder = Path(home) / '.local/share/dispatch/rule-history'; folder.mkdir(parents=True, exist_ok=True)
    with open(folder / '.lock', 'a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        proposal = plan(home, payload['path'], payload['content'], payload.get('profile', 'auto'), payload.get('model', ''), project=project)
        if payload.get('hashes') != proposal['hashes']: raise ValueError('文档已被其他程序修改，请重新检查差异')
        if not proposal['changes']: return {'changed': 0, 'backup': None}
        token = f'{time.time_ns()}'
        backup = folder / (token + '.json')
        atomic_write(backup, json.dumps(proposal, ensure_ascii=False))
        written = []
        try:
            for change in proposal['changes']:
                # Recheck immediately before each write, even after the plan was prepared.
                if str(Path(change['path']).resolve()) != change['real_path'] or digest(text(Path(change['path']))) != change['hash']: raise ValueError('写入前检测到文件或软链接变化')
                atomic_write(change['path'], change['after']); written.append(change)
        except Exception:
            for change in reversed(written):
                if digest(text(Path(change['path']))) == digest(change['after']): atomic_write(change['path'], change['before'])
            raise
        return {'changed': len(written), 'backup': token}


def restore(home, token):
    import fcntl
    if not re.fullmatch(r'\d+', token): raise ValueError('无效的备份编号')
    folder = Path(home) / '.local/share/dispatch/rule-history'
    with open(folder / '.lock', 'a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        saved = json.loads(text(folder / (token + '.json'))); changes = saved['changes']
        for c in changes:
            if str(Path(c['path']).resolve()) != c['real_path'] or digest(text(Path(c['path']))) != digest(c['after']): raise ValueError('保存后文件或软链接又有修改，不能覆盖；请手动合并备份')
        for c in changes:
            if c.get('existed', True): atomic_write(c['path'], c['before'])
            else: Path(c['real_path']).unlink()
        return {'restored': len(changes)}


def command(a, home, project=None):
    import sys
    inv = inventory(home, project=project)
    if a.op == 'inspect': return {**inv, **audit(inv, a.profile, a.model or next((m['model'] for m in inv['models'] if m.get('model')), ''))}
    if a.op == 'restore': return restore(home, a.backup)
    if a.op == 'apply': return apply(home, json.load(sys.stdin), project=project)
    doc = next((d for d in inv['documents'] if d['path'] == a.path), None)
    if not doc: raise ValueError('请选择检测到的文件')
    new = tidy(doc['content']) if a.op == 'optimize' else sys.stdin.read()
    return {'content': new, **plan(home, a.path, new, a.profile, a.model, project=project)}
