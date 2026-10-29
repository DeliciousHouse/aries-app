import json
from pathlib import Path
c=json.loads(Path('field-contract-v2.json').read_text())
fields=c['fields'];assert len(fields)==270
assert len({(f['source_location'],f['field']) for f in fields})==270
required={'source_location','field','aries_provenance','consumer','classification','target_mapping','verification','disposition'}
assert all(required<=f.keys() for f in fields)
assert all(f['approval'] is None for f in fields)
assert c['unresolved_owner_category_approvals']==[]
assert not c['authority']['activation_authorized'] and not c['authority']['cutover_authorized']
for name,value in [('enabled','false'),('state','paused'),('next_run_at','null')]:
 f=next(f for f in fields if f['field']=='jobs[0].'+name)
 assert f['target_mapping'].endswith(value)
a=json.loads(Path('relocation-auth-evidence.json').read_text());assert a['scheduler']['synthetic_cases_passed']==3
r=json.loads(Path('research-admission-evidence.json').read_text());assert r['synthetic_research_payload']['status']==400 and r['positive_input_control']
s=json.loads(Path('relocation-source-evidence.json').read_text());assert len(s['files'])==8 and all(f['exists'] and f['matches_previous'] for f in s['files'].values())
print(json.dumps({'contract_schema_assertions':'PASS','fields':len(fields),'unique_fields':len(fields),'reviewed_code_hashes':len(s['files']),'scheduler_synthetic_cases':3,'research_admission_controls':2,'functional_certification':False,'activation_authorized':False}))
