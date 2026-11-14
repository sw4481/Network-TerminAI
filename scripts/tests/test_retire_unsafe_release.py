"""Execute the incident-only workflow JavaScript with local API mocks."""
import json
from pathlib import Path
import subprocess
import unittest


ROOT = Path(__file__).resolve().parents[2]
HARNESS = r"""
const assert = require('node:assert/strict');
const scenario = JSON.parse(process.argv[1]);
const bad = '4cd4d5ac6633e2a4c37c6d50dd0acb5ebb365ed2';
const repo = 'sw4481/Network-TerminAI';
const context = {repo:{owner:'sw4481',repo:'Network-TerminAI'},ref:'refs/tags/v1.1.19'};
let release = {id:445040852,tag_name:'v1.1.17',draft:true,published_at:null,assets:[{id:101}]};
let run = {id:43561458598,head_sha:bad,head_branch:'v1.1.17',event:'push',
  path:'.github/workflows/release.yml',run_attempt:1,status:'queued',conclusion:null,
  repository:{full_name:repo},head_repository:{full_name:repo}};
let tag = {object:{type:'commit',sha:bad}};
let ref = {ref:'refs/tags/v1.1.17',object:{type:'tag',sha:'annotated-tag'}};
let jobs = ['package-linux-x86_64','package-macos-aarch64','package-windows-x86_64']
  .map(name=>({name,status:'queued',conclusion:null,run_id:run.id,head_sha:bad}));
jobs.unshift(...['release-preflight','create-draft-release'].map(name=>
  ({name,status:'completed',conclusion:'success',run_id:run.id,head_sha:bad})));
const calls=[];
let waits=0;
const setTimeout=(callback,delay)=>{assert.equal(delay,60000);waits++;callback();};
const error = status => Object.assign(new Error(`HTTP ${status}`),{status});
if(scenario.name.startsWith('wait_')) {
  jobs.filter(job=>job.name.startsWith('package-')).forEach(job=>{
    job.status='completed'; job.conclusion='success';
  });
  Object.assign(jobs[2],{status:'in_progress',conclusion:null,steps:[
    {name:'Run Rust checks from Cargo.lock',number:16,status:'completed',conclusion:'success',
      started_at:'earlier',completed_at:'earlier'},
    {name:'Build and upload native bundles',number:18,status:'in_progress',conclusion:null,
      started_at:'today',completed_at:null}
  ]});
}
if(scenario.name.startsWith('early_')) {
  run.status='in_progress';
  jobs.filter(job=>job.name.startsWith('package-')).forEach(job=>{
    job.status='completed'; job.conclusion='success';
  });
  Object.assign(jobs[2],{status:'in_progress',conclusion:null,steps:[
    {name:'Run Rust checks from Cargo.lock',number:16,status:'in_progress',conclusion:null,
      started_at:'2026-11-14T06:33:52Z',completed_at:null},
    {name:'Build and upload native bundles',number:18,status:'pending',conclusion:null,
      started_at:null,completed_at:null}
  ]});
}
switch(scenario.name) {
case 'wrong_numeric_id': release.id=445040853; break;
case 'terminal_unknown_conclusion': run.status='completed'; run.conclusion='unexpected'; break;
case 'terminal_null_conclusion': run.status='completed'; break;
case 'invalid_draft_flag': release.draft='true'; break;
case 'invalid_published_at': release.published_at=42; break;
case 'active_public_terminal': case 'active_public_timeout':
  release.draft=false;release.published_at='today';break;
case 'terminal_historical': run.status='completed'; run.conclusion='cancelled'; release.published_at='yesterday'; break;
case 'terminal_public': case 'terminal_patch_error': case 'terminal_patch_bad_status':
case 'terminal_patch_not_draft': case 'terminal_verify_public': case 'terminal_verify_id':
case 'terminal_verify_error':
  run.status='completed'; run.conclusion='success';release.draft=false;release.published_at='yesterday';break;
case 'early_rust_pending': jobs[2].steps[0].status='pending'; jobs[2].steps[0].started_at=null; break;
case 'early_missing_rust': jobs[2].steps.shift(); break;
case 'early_missing_upload': jobs[2].steps.pop(); break;
case 'early_duplicate_rust': jobs[2].steps.push({...jobs[2].steps[0]}); break;
case 'early_duplicate_upload': jobs[2].steps.push({...jobs[2].steps[1]}); break;
case 'early_wrong_rust_name': jobs[2].steps[0].name='other'; break;
case 'early_wrong_upload_name': jobs[2].steps[1].name='other'; break;
case 'early_wrong_rust_number': jobs[2].steps[0].number=15; break;
case 'early_wrong_upload_number': jobs[2].steps[1].number=17; break;
case 'early_rust_completed': jobs[2].steps[0].status='completed'; break;
case 'early_rust_conclusion': jobs[2].steps[0].conclusion='success'; break;
case 'early_rust_completed_at': jobs[2].steps[0].completed_at='today'; break;
case 'early_pending_started': jobs[2].steps[0].status='pending'; break;
case 'early_active_missing_started': jobs[2].steps[0].started_at=null; break;
case 'early_active_empty_started': jobs[2].steps[0].started_at=''; break;
case 'early_upload_active': jobs[2].steps[1].status='in_progress'; break;
case 'early_upload_completed': jobs[2].steps[1].status='completed'; break;
case 'early_upload_skipped': jobs[2].steps[1].conclusion='skipped'; break;
case 'early_upload_started': jobs[2].steps[1].started_at='today'; break;
case 'early_upload_completed_at': jobs[2].steps[1].completed_at='today'; break;
case 'early_missing_steps': delete jobs[2].steps; break;
case 'early_wrong_steps': jobs[2].steps={}; break;
case 'early_publisher_active': jobs.push({...jobs[0],name:'validate-and-publish',status:'in_progress',conclusion:null}); break;
case 'early_publisher_success': jobs.push({...jobs[0],name:'validate-and-publish'}); break;
case 'wrong_repo': context.repo.owner='other'; break;
case 'wrong_current_tag': context.ref='refs/tags/v1.1.18'; break;
case 'wrong_ref': ref.ref='refs/tags/v1.1.16'; break;
case 'wrong_tag_commit': tag.object.sha='wrong'; break;
case 'nested_tag': tag.object.type='tag'; break;
case 'lightweight_tag': ref.object={type:'commit',sha:bad}; break;
case 'public_release': release.draft=false; release.published_at='today'; break;
case 'published_at': release.published_at='today'; break;
case 'wrong_release_tag': release.tag_name='v1.1.16'; break;
case 'invalid_id': release.id='17'; break;
case 'wrong_run': run.id=1; break;
case 'wrong_run_sha': run.head_sha='wrong'; break;
case 'wrong_run_repo': run.repository.full_name='other/repo'; break;
case 'wrong_head_repo': run.head_repository.full_name='other/repo'; break;
case 'wrong_run_tag': run.head_branch='main'; break;
case 'wrong_workflow': run.path='.github/workflows/ci.yml'; break;
case 'wrong_event': run.event='workflow_dispatch'; break;
case 'rerun': run.run_attempt=2; break;
case 'terminal': run.status='completed'; run.conclusion='cancelled'; break;
case 'unknown_status': run.status='waiting'; break;
case 'active_conclusion': run.conclusion='success'; break;
case 'no_queued_package': jobs.filter(j=>j.name.startsWith('package-')).forEach(j=>j.status='in_progress'); break;
case 'publisher_active': jobs.push({...jobs[0],name:'validate-and-publish',status:'in_progress',conclusion:null}); break;
case 'publisher_success': jobs.push({...jobs[0],name:'validate-and-publish'}); break;
case 'publisher_queued': jobs.push({...jobs[2],name:'validate-and-publish'}); break;
case 'wrong_job_run': jobs[2].run_id=1; break;
case 'wrong_job_sha': jobs[2].head_sha='wrong'; break;
case 'duplicate_job': jobs.push({...jobs[2]}); break;
case 'missing_package': jobs.pop(); break;
case 'unknown_job': jobs.push({...jobs[2],name:'unexpected'}); break;
}
const github={rest:{git:{
  getRef:async args=>{calls.push('ref');assert.equal(args.ref,'tags/v1.1.17');return {data:ref};},
  getTag:async args=>{calls.push('tag');assert.equal(args.tag_sha,'annotated-tag');
    if(scenario.name==='wait_changed_ref' && waits) return {data:{object:{type:'commit',sha:'changed'}}};
    return {data:tag};}
},repos:{
  getReleaseByTag:async()=>{calls.push('lookup');throw error(404);},
  getRelease:async args=>{calls.push('get');
    assert([445040852,445040853].includes(args.release_id));
    if(calls.filter(call=>call==='get').length===1) {
      assert.equal(args.release_id,445040852);
      if(scenario.name==='missing') throw error(404);
      if(scenario.name==='lookup_error') throw error(403);
    }
    if(calls.includes('update')) {
      if(scenario.name==='terminal_verify_public') return {data:{...release,draft:false}};
      if(scenario.name==='terminal_verify_id') return {data:{...release,id:445040853}};
      if(scenario.name==='terminal_verify_error') throw error(403);
      return {data:release};
    }
    if(calls.includes('delete')) {
      if(scenario.name==='delete_not_effective') return {data:release};
      if(scenario.name==='verify_error') throw error(403);
      throw error(404);
    }
    if(scenario.name==='changed_id') return {data:{...release,id:18}};
    if(scenario.name==='wait_changed_id' && waits) return {data:{...release,id:445040853}};
    if(scenario.name==='became_public' && calls.filter(call=>call==='get').length>1) return {data:{...release,draft:false,published_at:'today'}};
    if(scenario.name==='reread_error' && calls.filter(call=>call==='get').length>1) throw error(404);
    return {data:release};},
  updateRelease:async args=>{calls.push('update');
    assert.deepEqual(args,{owner:'sw4481',repo:'Network-TerminAI',release_id:445040852,draft:true});
    assert.equal(run.status,'completed');assert.equal(release.draft,false);
    if(scenario.name==='terminal_patch_error') throw error(403);
    if(scenario.name!=='terminal_patch_not_draft') release={...release,draft:true};
    assert.deepEqual(release.assets,[{id:101}]);
    return {status:scenario.name==='terminal_patch_bad_status'?202:200,data:release};},
  deleteRelease:async args=>{calls.push('delete');assert.equal(args.release_id,445040852);
    assert.equal(release.draft,true);assert.equal(release.published_at,null);
    if(scenario.name==='delete_error') throw error(403);
    return {status:scenario.name==='delete_bad_status'?202:204};}
}}};
const fetch=async (url,options)=>{
  calls.push(url.endsWith('/jobs?per_page=100')?'jobs':'run');
  assert.equal(options.redirect,'error');
  assert(!Object.keys(options.headers).some(k=>k.toLowerCase()==='authorization'));
  assert(options.signal);
  assert(url===`https://api.github.com/repos/${repo}/actions/runs/43561458598` ||
    url===`https://api.github.com/repos/${repo}/actions/runs/43561458598/jobs?per_page=100`);
  if(scenario.name==='fetch_error') throw new Error('network');
  if(scenario.name==='wait_fetch_error' && waits) throw new Error('network');
  if(scenario.name==='active_public_terminal' && waits) {run.status='completed';run.conclusion='success';}
  if(scenario.name.startsWith('wait_') && waits && scenario.name!=='wait_timeout') {
    if(scenario.name==='wait_public_transition' && waits===1) {release.draft=false;release.published_at='today';}
    else {run.status='completed';run.conclusion='success';}
    if(scenario.name==='wait_withdraw') {release.draft=false;release.published_at='today';}
    if(scenario.name==='wait_changed_attempt') run.run_attempt=2;
  }
  return {ok:scenario.name!=='public_403',status:scenario.name==='public_403'?403:200,
    json:async()=>url.endsWith('/jobs?per_page=100')?
      {total_count:scenario.name==='truncated_jobs'?101:jobs.length,jobs}:run};
};
const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;
const fs=require('node:fs');
const source=fs.readFileSync(0,'utf8');
(async()=>{
  let failed=false;
  try {await new AsyncFunction('github','context','core','fetch','setTimeout',source)(github,context,{info:()=>{}},fetch,setTimeout);}
  catch(error) {failed=true;}
  assert.equal(failed,scenario.fails,JSON.stringify({scenario,calls}));
  assert.equal(calls.includes('delete'),scenario.deletes,JSON.stringify({scenario,calls}));
  assert.equal(calls.includes('update'),scenario.updates,JSON.stringify({scenario,calls}));
  assert(!calls.includes('lookup'),'published-only tag lookup must never bypass the known draft ID');
  if(scenario.deletes) {
    const reread=calls.indexOf('get',calls.indexOf('jobs')+1);
    assert(calls.indexOf('jobs')<reread && reread<calls.indexOf('delete'));
  }
  if(scenario.name==='terminal') assert(!calls.includes('jobs'));
  if(scenario.name==='wait_timeout') assert.equal(waits,55);
  if(scenario.name==='active_public_timeout') assert.equal(waits,55);
  if(scenario.name.startsWith('active_public_')) assert(!calls.includes('jobs'));
  if(scenario.name==='wait_public_transition') assert.equal(waits,2);
  if(scenario.name.startsWith('wait_')) assert.equal(calls.filter(c=>c==='jobs').length,1);
  if(waits) assert(calls.filter(c=>c==='run').length<=56);
})().catch(error=>{console.error(error);process.exitCode=1;});
"""


class UnsafeReleaseRetirementTests(unittest.TestCase):
    def test_actual_inline_guards(self):
        workflow = (ROOT / ".github/workflows/release.yml").read_text()
        marker = "      - name: Contain the unsafe v1.1.17 release\n"
        self.assertIn(marker, workflow, "incident-only retirement step is absent")
        step = workflow.split(marker, 1)[1].split("      - name:", 1)[0]
        script = "\n".join(line[12:] for line in step.split("          script: |\n", 1)[1].splitlines())
        noops = ["terminal", "terminal_historical", "wait_draft"]
        withdrawals = ["terminal_public", "wait_withdraw", "wait_public_transition", "active_public_terminal"]
        positives = ["active", "publisher_queued", "early_rust_active", "early_rust_pending"]
        failures = [
            "wrong_repo", "wrong_current_tag", "wrong_ref", "wrong_tag_commit",
            "nested_tag", "lightweight_tag", "public_release", "published_at",
            "wrong_release_tag", "invalid_id", "wrong_run", "wrong_run_sha",
            "wrong_run_repo", "wrong_head_repo", "wrong_run_tag", "wrong_workflow",
            "wrong_event", "rerun", "unknown_status", "active_conclusion",
            "no_queued_package", "publisher_active", "publisher_success",
            "wrong_job_run", "wrong_job_sha", "duplicate_job", "missing_package",
            "unknown_job", "lookup_error", "changed_id", "became_public",
            "reread_error", "fetch_error", "public_403", "truncated_jobs",
            "delete_error", "delete_bad_status", "delete_not_effective", "verify_error",
            "early_missing_rust", "early_missing_upload", "early_duplicate_rust",
            "early_duplicate_upload", "early_wrong_rust_name", "early_wrong_upload_name",
            "early_wrong_rust_number", "early_wrong_upload_number", "early_rust_completed",
            "early_rust_conclusion", "early_rust_completed_at", "early_pending_started",
            "early_active_missing_started", "early_active_empty_started", "early_upload_active",
            "early_upload_completed", "early_upload_skipped", "early_upload_started",
            "early_upload_completed_at", "early_missing_steps", "early_wrong_steps",
            "early_publisher_active", "early_publisher_success",
            "wrong_numeric_id", "terminal_patch_error", "terminal_patch_bad_status",
            "terminal_patch_not_draft", "terminal_verify_public", "terminal_verify_id",
            "terminal_verify_error", "wait_timeout", "wait_fetch_error",
            "wait_changed_attempt", "wait_changed_ref", "wait_changed_id",
            "terminal_unknown_conclusion", "terminal_null_conclusion",
            "invalid_draft_flag", "invalid_published_at",
            "active_public_timeout",
            "missing",
        ]
        after_delete = {"delete_error", "delete_bad_status", "delete_not_effective", "verify_error"}
        after_update = {name for name in failures if name.startswith("terminal_patch") or name.startswith("terminal_verify")}
        for name in positives + noops + withdrawals + failures:
            with self.subTest(name=name):
                scenario = {"name": name, "fails": name in failures,
                            "deletes": name in positives or name in after_delete,
                            "updates": name in withdrawals or name in after_update}
                result = subprocess.run(
                    ["node", "-e", HARNESS, json.dumps(scenario)], input=script,
                    text=True, capture_output=True, cwd=ROOT, timeout=10,
                )
                self.assertEqual(result.returncode, 0, result.stdout + result.stderr)


if __name__ == "__main__":
    unittest.main()
