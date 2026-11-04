import json, subprocess, hashlib
from pathlib import Path
contract = json.loads(Path('field-contract.json').read_text())
remote = '''from pathlib import Path
import hashlib,json,subprocess
paths = PATHS
out={"app_revision":subprocess.check_output(["git","-C","/home/node/aries-app","rev-parse","HEAD"],text=True).strip(),"hermes_revision":subprocess.check_output(["git","-C","/home/node/.hermes/hermes-agent","rev-parse","HEAD"],text=True).strip(),"files":{}}
for name in paths:
 p=Path(name)
 out["files"][name]={"exists":p.is_file(),"sha256":hashlib.sha256(p.read_bytes()).hexdigest() if p.is_file() else None}
print(json.dumps(out))
'''.replace('PATHS',repr(list(contract['observed_code_hashes'])))
p=subprocess.run(['ssh','-o','BatchMode=yes','-o','StrictHostKeyChecking=yes','-o','ConnectTimeout=10','node@100.65.234.31','python3 -'],input=remote,text=True,capture_output=True,timeout=60)
if p.returncode: raise RuntimeError(p.stderr)
result=json.loads(p.stdout)
for name, item in result['files'].items(): item['matches_previous']=item['sha256']==contract['observed_code_hashes'][name]
Path('relocation-source-evidence.json').write_text(json.dumps(result,indent=2)+'\n')
print(json.dumps(result,indent=2))
print('FIELD LOCATIONS',json.dumps(sorted(set(x['source_location'] for x in contract['fields']))))
print('JOB FIELDS',json.dumps([x for x in contract['fields'] if 'job' in x['source_location'] or 'ARIES_APP_CONTAINER' in x['field']],indent=2))
