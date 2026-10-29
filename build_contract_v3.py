import json, hashlib, zipfile
from pathlib import Path
from datetime import datetime, timezone
x=json.loads(Path('source-handoff-review.json').read_text()); m=x['manifest']; e=x['evidence']
c=json.loads(Path('field-contract-v2.json').read_text())
c['schema_version']=3;c['generated_at']=datetime.now(timezone.utc).isoformat()
c['status']='SOURCE_PRESERVATION_CONTRACT_ACCEPTED; TARGET_EXECUTION_GATES_REMAIN'
c['installed_hermes_revision']=m['snapshot_verification']['revision_after']
c['supersedes']='v1 and v2; no category prompts or partial-installation exclusions; source non-serving baseline now mapped, not repaired'
c['source_manifest']={'path':'/home/node/aries-migration-t_0cf9fdf0/relocation-t_6188ad57-20260915T074208Z-3b264416/sanitized-manifest.json','sha256':'1c07a4fd710bed824e6fc51d7fc6c5627d65b7280b91d3652d1c5d5ae555452d','components':len(m['components']),'bytes':sum(r['bytes'] for r in m['components']),'verification':'Reviewer fresh size/mode checks all34; fresh SHA25632; two large archives retain producer/independent member receipts, mandatory target full hash.'}
c['source_snapshot_lineage']=m['snapshot_verification']
c['source_baseline']={'route':'app default/research -> host.docker.internal -> 172.17.0.1:8642; research /v1/runs','observed_receiver':'None: repeated source-owner privileged listener/NAT samples and four inactive MainPID0 units. This is sampled source evidence, not a reviewer live auth test.','auth':'Root intended unit HOME has no API_SERVER_KEY in file/manager; aries-default extra.key candidate equals app key. Config extra.key precedes env. No credential values or authenticated requests.','research':'Dedicated profile configured127.0.0.1:8651, not app8642. Synthetic missing-input400 is baseline code evidence only. Preserve existing behavior; no repair under relocation.','limitations':['unit PATH lacks npx','missing .hermeslink reference','app unhealthy; deployment runner active','shared consumers remain source-active']}
c['security_findings']=[]
c['remaining_gates']=['TARGET_FULL_HASHES_AND_AGGREGATE_CAPACITY','TARGET_NATIVE_PATH_SYMLINK_RUNTIME_PARITY','TARGET_PRIVATE_AUTH_TENANT_INTEGRATION_FLOWS','HISTORICAL_CHRONOS_AND_MEDIA_ASSURANCE','SHARED_CONSUMER_SINGLE_ACTIVE_HANDOFF','APPROVED_FREEZE_FINAL_DELTA_QUEUE_RECONCILIATION_CUTOVER_AND_TRAFFIC_ROLLBACK']
c['downstream_owner']='t_a3e604b4 (Dora); these are not reverse dependencies on this completed source-contract phase'
c['installation_dependency_groups'][0]['verification']='Source explicit manifest and private verified index now supplied; 22 profiles,151 SQLite backups,248467 entries; target parity remains required.'
c['installation_dependency_groups'][1]['verification']='Captured revision '+c['installed_hermes_revision']+' with stable before/after receipt and restored Git fsck0; target must match native dependencies, dirty state and path behavior, not Dockerfile pin.'
c['installation_dependency_groups'][2]['verification']='Source intended root HOME and cwd override mapped; unit inactive/MainPID0. Preserve discrepancy, no substitution of aries-default key/profile.'
c['path_mapping_contract']={'home':'Map source /home/node/.hermes to reserved TARGET_HERMES_HOME, retain relative profile/store IDs; never merge with target shared HOME.','units':'Preserve exact unit fragments/wrapper bytes inert, do not install. Future effective HOME/ExecStart/cwd/PATH mapping must be explicit and separately verified.','external_dependencies':'Use explicit source manifest entrypoint/context/Firecrawl/legacy-Python archives; restore only within task-owned inert dependency storage. Do not overwrite shared target paths. Dora must record exact per-path execution bindings before runtime testing.','links':'Inspect all symlink/hardlink destinations before extraction; reject traversal/escape, retain original bytes as evidence. No dereferencing into live target HOME. Mapped working links must resolve within isolated installation/dependency roots; unresolved links remain held, not deleted.','jobs':'Original definitions remain preserved unchanged. Separate working jobs disabled=false is NOT valid: require enabled=false,state=paused,next_run_at=null; scheduler/dispatcher/send paths inactive and egress denied.','user_count_container':'ARIES_APP_CONTAINER=aries-a3e604b4-app is rehearsal-only; production container and database scope require Dora verification. No source fallback or script execution.','delivery':'Existing route/capability consent resolved; preserve privately. Delivery execution still requires single-active cutover and verified recipient continuity, no test sends.'}
c['evidence_files']=['source-handoff-review.json','relocation-auth-evidence.json','research-admission-evidence.json']
c['security_verdict']='Accept protected like-for-like source preservation and inactive target mapping contract only; no working gateway/research, full migration, activation or cutover certification.'
c['rollback']='Before activation retain source originals, backups and source active ownership; failed quarantine validation leaves target stopped. Production traffic rollback remains Dora prerequisite, not proved by database restore.'
Path('field-contract-v3.json').write_text(json.dumps(c,indent=2)+'\n')
assert len(c['fields'])==len({(f['source_location'],f['field']) for f in c['fields']})==270
assert all(f['approval'] is None for f in c['fields']) and c['unresolved_owner_category_approvals']==[]
assert not c['authority']['activation_authorized'] and not c['authority']['cutover_authorized']
for k,v in [('enabled','false'),('state','paused'),('next_run_at','null')]: assert next(f for f in c['fields'] if f['field']=='jobs[0].'+k)['target_mapping'].endswith(v)
assert len(x['checks'])==34 and sum(r['fresh_hash'] for r in x['checks'])==32
assert json.loads(e['route-auth-evidence.json'])['gateway_listeners']==[]
assert c['source_snapshot_lineage']['cross_store_consistent'] is False
verdict='SOURCE-EXISTS  PASS  Strict SSH manifest SHA2561c07a4fd verified;34 component size/mode checks and32 fresh hashes passed;2 large archives retain identified upstream full/member receipts, not reviewer rehash.\nCLAIMS-TRACE  PASS  Source route/auth and snapshot receipts map preservation claims: no serving8642 receiver, root/profile discrepancy retained,22-profile online capture; no live functionality or cross-store consistency claimed.\nREVERT-SAFE  PASS  Contract retains source/backups and keeps target inactive; failed quarantine leaves source ownership intact. Production traffic rollback remains downstream prerequisite.\n'
Path('security-verdict-v3.txt').write_text(verdict)
Path('contract-validation-v3.json').write_text(json.dumps({'field_schema_assertions':'PASS','fields':270,'unique_fields':270,'component_checks':34,'fresh_component_hashes':32,'functional_certification':False,'activation_authorized':False},indent=2)+'\n')
files=['field-contract-v3.json','security-verdict-v3.txt','contract-validation-v3.json','source-handoff-review.json','verify_source_handoff.py','build_contract_v3.py']
Path('artifact-manifest-v3.json').write_text(json.dumps({f:hashlib.sha256(Path(f).read_bytes()).hexdigest() for f in files},indent=2)+'\n')
with zipfile.ZipFile('aries-relocation-contract-v3.zip','w',zipfile.ZIP_DEFLATED) as z:
 for f in files+['artifact-manifest-v3.json']: z.write(f)
with zipfile.ZipFile('aries-relocation-contract-v3.zip') as z: assert z.testzip() is None
print(verdict);print('bundle_sha256',hashlib.sha256(Path('aries-relocation-contract-v3.zip').read_bytes()).hexdigest())
