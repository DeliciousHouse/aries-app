import json, subprocess, hashlib
from pathlib import Path
root='/home/node/aries-migration-t_0cf9fdf0/relocation-t_6188ad57-20260915T074208Z-3b264416'
remote='''from pathlib import Path
import json,hashlib,stat
root=Path(ROOT)
b=(root/'sanitized-manifest.json').read_bytes()
assert hashlib.sha256(b).hexdigest()=='1c07a4fd710bed824e6fc51d7fc6c5627d65b7280b91d3652d1c5d5ae555452d'
m=json.loads(b); rows=m['components']; assert len(rows)==len({r['path'] for r in rows})==34
assert sum(r['bytes'] for r in rows)==m['component_bytes']
out={'manifest':m,'checks':[],'evidence':{}}
for r in rows:
 p=Path(r['path']); s=p.lstat(); assert stat.S_ISREG(s.st_mode) and s.st_size==r['bytes'] and stat.S_IMODE(s.st_mode)==0o600
 checked=s.st_size<100000000
 if checked: assert hashlib.sha256(p.read_bytes()).hexdigest()==r['sha256']
 out['checks'].append({'name':p.name,'size_mode_pass':True,'fresh_hash':checked})
 if p.name in ['SCOPE-MATRIX-v2.md','route-auth-evidence.json','manager-auth-provenance.json','snapshot-verification.json','snapshot-scope-summary.json','handoff-runtime-sample.json','unit-path-evidence.json']:
  out['evidence'][p.name]=p.read_text()
print(json.dumps(out))
'''.replace('ROOT',repr(root))
p=subprocess.run(['ssh','-o','BatchMode=yes','-o','StrictHostKeyChecking=yes','-o','ConnectTimeout=10','node@100.65.234.31','python3 -'],input=remote,text=True,capture_output=True,timeout=180)
if p.returncode: raise RuntimeError(p.stderr)
x=json.loads(p.stdout)
Path('source-handoff-review.json').write_text(json.dumps(x,indent=2)+'\n')
print(json.dumps({'components':len(x['checks']),'fresh_hashes':sum(r['fresh_hash'] for r in x['checks'])}))
for name,text in x['evidence'].items(): print(name+'\n'+text)
