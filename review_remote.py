from pathlib import Path
import subprocess, re, json
R=Path('/home/node/aries-app')
files=subprocess.check_output(['git','-C',str(R),'ls-files'],text=True).splitlines()
for f in files:
 if f.endswith(('.ts','.py','.yml','.yaml','.sh')) and not f.startswith(('tests/','__tests__/')):
  p=R/f
  if not p.is_file(): continue
  lines=p.read_text(errors='replace').splitlines()
  matches=[(i,l) for i,l in enumerate(lines,1) if re.search(r'HERMES_(?:GATEWAY_URL|API_SERVER_KEY|.*GATEWAY|PROFILE)|API_SERVER_(?:KEY|ENABLED|HOST|PORT)|/v1/runs',l)]
  if matches:
   print('\n'+f)
   for i,l in matches: print(f'{i}:{l[:250]}')
H=Path('/home/node/.hermes/hermes-agent')
print('HERMES REVISION',subprocess.check_output(['git','-C',str(H),'rev-parse','HEAD'],text=True).strip())
for folder in ['gateway','plugins/platforms','cron','hermes_cli']:
 for p in (H/folder).rglob('*.py'):
  if p.name not in ['config.py','api_server.py','jobs.py','scheduler.py','run.py'] and 'api_server' not in str(p): continue
  lines=p.read_text(errors='replace').splitlines()
  matches=[(i,l) for i,l in enumerate(lines,1) if re.search(r'API_SERVER_(?:KEY|HOST|PORT|ENABLED)|/v1/runs|paused|enabled.*False|get_hermes_home',l)]
  if matches:
   print('\n'+str(p))
   for i,l in matches[:45]: print(f'{i}:{l[:220]}')
