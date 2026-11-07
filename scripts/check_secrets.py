#!/usr/bin/env python3
"""Check the actual Git index, optionally all reachable commit blobs. Never print values."""
import argparse, re, subprocess, sys
from pathlib import Path
root=Path(__file__).resolve().parents[1]
def git(*args): return subprocess.check_output(['git',*args],cwd=root)
parser=argparse.ArgumentParser();parser.add_argument('--history',action='store_true');parser.add_argument('--build',action='store_true');args=parser.parse_args()
known=set()
local=root/'app/.env.local'
if local.exists():
    for line in local.read_text().splitlines():
        m=re.match(r'[A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD)[A-Z0-9_]*=(.*)',line)
        if m:
            value=m[1].strip().strip('\'"')
            if len(value)>8: known.add(value.encode())
patterns={
 'provider credential':rb'(?:sk-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{25,})',
 'private key':rb'-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----',
 'literal bearer credential':rb'Bearer\s+[A-Za-z0-9_.-]{25,}',
 'literal secret':rb'(?i)(?:api[_-]?key|access[_-]?token|password|secret)\s*[:=]\s*[\x22\x27]([A-Za-z0-9_./+=-]{18,})[\x22\x27]',
}
allowed={b'sk-PRIVATE_SENTINEL'} # Deliberate fake value used by the audit redaction test.
errors=[];count=0
def check(path,data,where):
    global count
    count+=1
    if ('.env' in Path(path).name and Path(path).name!='.env.example') or re.search(r'\.(sqlite|db|pem|key)(\.|$)',path):errors.append((where,path,0,'forbidden file'))
    for value in known:
        if value in data:errors.append((where,path,0,'exact local credential match'))
    for label,pattern in patterns.items():
        for m in re.finditer(pattern,data):
            if m.group(1 if m.lastindex else 0) in allowed:continue
            errors.append((where,path,data[:m.start()].count(b'\n')+1,label))
files=[p.decode() for p in git('ls-files','-z').split(b'\0') if p]
if not files:sys.exit('FAIL: Git index is empty; stage the intended files first.')
for path in files:check(path,git('show',':'+path),'index')
if args.history:
    seen=set()
    for commit in git('rev-list','--all').decode().splitlines():
        for entry in git('ls-tree','-r','-z',commit).split(b'\0'):
            if not entry:continue
            info,path=entry.split(b'\t',1);_,kind,oid=info.split()
            if kind!=b'blob' or oid in seen:continue
            seen.add(oid);check(path.decode(),git('cat-file','blob',oid.decode()),'history')
if args.build:
    for path in (root/'app/dist').rglob('*'):
        if path.is_file():check(str(path.relative_to(root)),path.read_bytes(),'build')
for where,path,line,label in errors:print(f'FAIL {where}: {path}:{line}: {label} [value redacted]')
if errors:sys.exit(1)
print(f'PASS: {count} indexed/history/build files checked; credential values never printed.')
