import json,pathlib,subprocess

def run():
    result=subprocess.run(['go','test','-json','.','-count=1'],capture_output=True,text=True)
    failures=[]
    for line in result.stdout.splitlines():
        try:event=json.loads(line)
        except ValueError:continue
        if event.get('Action')=='fail' and event.get('Test'):failures.append(event['Test'])
    return result.returncode,failures

code,failed=run();result={'suite_passed':code==0,'corrupted_roundtrip_detected':False,'unsafe_acceptance_detected':False}
path=pathlib.Path('portable_bundle.go')
if path.exists():
    original=path.read_text()
    for key,before,after in [
      ('corrupted_roundtrip_detected','data,e:=os.ReadFile(path);if e!=nil{return e}','data,e:=os.ReadFile(path);if e!=nil{return e};data=append(data, byte(88))'),
      ('unsafe_acceptance_detected','return nil,fmt.Errorf("unsafe bundle member %q",name)','continue')]:
        if before not in original:continue
        try:
            path.write_text(original.replace(before,after,1));code,failed=run();result[key]=code==1 and bool(failed)
        finally:path.write_text(original)
print(json.dumps(result,sort_keys=True))
