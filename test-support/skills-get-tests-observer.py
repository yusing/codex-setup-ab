import json, pathlib, subprocess, tempfile

def run_tests():
    result = subprocess.run(['go','test','-json','.','-count=1'],capture_output=True,text=True)
    events=[]
    for line in result.stdout.splitlines():
        try: events.append(json.loads(line))
        except ValueError: pass
    failed=[e['Test'] for e in events if e.get('Action')=='fail' and e.get('Test')]
    return result.returncode,failed

code,failed=run_tests()
output={'suite_passed':code==0,'fast_mutation_detected':False,'glob_mutation_detected':False}
for key,name,before,after in [
 ('fast_mutation_detected','skill_context.go','evaluator.singleUse = true','evaluator.singleUse = false'),
 ('glob_mutation_detected','selection.go','_, e.evidence.shortCircuit = canonicalLanguage(call.Args[1].Lit())','e.evidence.shortCircuit = true')]:
    path=pathlib.Path(name); original=path.read_text()
    if before not in original: continue
    try:
        path.write_text(original.replace(before,after,1))
        mutant_code,failed=run_tests()
        output[key]=mutant_code==1 and bool(failed)
    finally: path.write_text(original)
print(json.dumps(output,sort_keys=True))
