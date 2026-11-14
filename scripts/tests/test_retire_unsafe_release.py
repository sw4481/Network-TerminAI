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
const context = {repo:{owner:'sw4481',repo:'Network-TerminAI'},ref:'refs/tags/v1.1.18'};
let release = {id:17,tag_name:'v1.1.17',draft:true,published_at:null};
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
const error = status => Object.assign(new Error(`HTTP ${status}`),{status});
switch(scenario.name) {
case 'wrong_repo': context.repo.owner='other'; break;
case 'wrong_current_tag': context.ref='refs/tags/v1.1.19'; break;
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
  getTag:async args=>{calls.push('tag');assert.equal(args.tag_sha,'annotated-tag');return {data:tag};}
},repos:{
  getReleaseByTag:async args=>{calls.push('lookup');assert.equal(args.tag,'v1.1.17');
    if(scenario.name==='missing') throw error(404);
    if(scenario.name==='lookup_error') throw error(403);
    return {data:release};},
  getRelease:async args=>{assert.equal(args.release_id,17);calls.push('get');
    if(calls.includes('delete')) {
      if(scenario.name==='delete_not_effective') return {data:release};
      if(scenario.name==='verify_error') throw error(403);
      throw error(404);
    }
    if(scenario.name==='changed_id') return {data:{...release,id:18}};
    if(scenario.name==='became_public') return {data:{...release,draft:false,published_at:'today'}};
    if(scenario.name==='reread_error') throw error(404);
    return {data:release};},
  deleteRelease:async args=>{assert.equal(args.release_id,17);calls.push('delete');
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
  return {ok:scenario.name!=='public_403',status:scenario.name==='public_403'?403:200,
    json:async()=>url.endsWith('/jobs?per_page=100')?
      {total_count:scenario.name==='truncated_jobs'?101:jobs.length,jobs}:run};
};
const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;
const fs=require('node:fs');
const source=fs.readFileSync(0,'utf8');
(async()=>{
  let failed=false;
  try {await new AsyncFunction('github','context','core','fetch',source)(github,context,{info:()=>{}},fetch);}
  catch(error) {failed=true;}
  assert.equal(failed,scenario.fails,JSON.stringify({scenario,calls}));
  assert.equal(calls.includes('delete'),scenario.deletes,JSON.stringify({scenario,calls}));
  if(scenario.deletes) assert(calls.indexOf('jobs')<calls.indexOf('get') && calls.indexOf('get')<calls.indexOf('delete'));
  if(scenario.name==='terminal') assert(!calls.includes('jobs'));
})().catch(error=>{console.error(error);process.exitCode=1;});
"""


class UnsafeReleaseRetirementTests(unittest.TestCase):
    def test_actual_inline_guards(self):
        workflow = (ROOT / ".github/workflows/release.yml").read_text()
        marker = "      - name: Retire only the unsafe v1.1.17 draft\n"
        self.assertIn(marker, workflow, "incident-only retirement step is absent")
        step = workflow.split(marker, 1)[1].split("      - name:", 1)[0]
        script = "\n".join(line[12:] for line in step.split("          script: |\n", 1)[1].splitlines())
        noops = ["missing", "terminal"]
        positives = ["active", "publisher_queued"]
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
        ]
        after_delete = {"delete_error", "delete_bad_status", "delete_not_effective", "verify_error"}
        for name in positives + noops + failures:
            with self.subTest(name=name):
                scenario = {"name": name, "fails": name in failures,
                            "deletes": name in positives or name in after_delete}
                result = subprocess.run(
                    ["node", "-e", HARNESS, json.dumps(scenario)], input=script,
                    text=True, capture_output=True, cwd=ROOT, timeout=10,
                )
                self.assertEqual(result.returncode, 0, result.stdout + result.stderr)


if __name__ == "__main__":
    unittest.main()
