import hashlib, json, os, pathlib, stat, subprocess, sys, tempfile, zipfile
scope=sys.argv[1]

def tree(root):
    return {str(p.relative_to(root)):{'data':p.read_bytes().hex(),'mode':stat.S_IMODE(p.stat().st_mode)} for p in sorted(root.rglob('*')) if p.is_file()}

with tempfile.TemporaryDirectory(prefix='ab-bundle-') as temp:
    root=pathlib.Path(temp)
    binary=root/'skills-mgr'
    built=subprocess.run(['go','build','-buildvcs=false','-o',str(binary),'.'],capture_output=True,text=True)
    if built.returncode:
        sys.stderr.write(built.stdout+built.stderr);raise SystemExit(built.returncode)
    def invoke(*args):
        return subprocess.run([str(binary),'bundle',*map(str,args)],capture_output=True,text=True,cwd=root,env=dict(os.environ,SKILLS_MGR_NO_REFRESH='1'))
    source=root/'source';source.mkdir()
    (source/'SKILL.md').write_text('---\nname: example\ndescription: Example.\n---\nbody\n');(source/'SKILL.md').chmod(0o644)
    (source/'references').mkdir();(source/'references'/'guide.md').write_bytes(b'reference\n');(source/'references'/'guide.md').chmod(0o644)
    (source/'scripts').mkdir();script=source/'scripts'/'check.sh';script.write_text('#!/bin/sh\nprintf checked\n');script.chmod(0o755)
    first=root/'first.bundle';second=root/'second.bundle'
    created=invoke('create',source,first)
    if scope=='commands':
        verified=invoke('verify',first);destination=root/'extracted';extracted=invoke('extract',first,destination)
        print(json.dumps({'created':created.returncode==0 and first.is_file(),'verified':verified.returncode==0,'extracted':extracted.returncode==0,'files':{name:entry['data'] for name,entry in tree(destination).items()} if destination.exists() else {}},sort_keys=True))
    elif scope=='reproducibility':
        for p in source.rglob('*'):os.utime(p,(1893456000,1893456000))
        other=root/'equivalent';other.mkdir()
        # Deliberately reverse filesystem creation order and change root/name/mtime.
        for p in sorted(source.rglob('*'),reverse=True):
            target=other/p.relative_to(source)
            if p.is_file():target.parent.mkdir(parents=True,exist_ok=True);target.write_bytes(p.read_bytes());target.chmod(stat.S_IMODE(p.stat().st_mode));os.utime(target,(1900000000,1900000000))
        again=invoke('create',other,second)
        print(json.dumps({'created':created.returncode==0 and again.returncode==0,'identical_bytes':first.exists() and second.exists() and first.read_bytes()==second.read_bytes()},sort_keys=True))
    elif scope=='executables':
        destination=root/'executable';extracted=invoke('extract',first,destination);target=destination/'scripts'/'check.sh'
        result={'extracted':extracted.returncode==0,'executable':target.exists() and stat.S_IMODE(target.stat().st_mode)&0o111!=0,'output':None}
        if target.exists() and os.access(target,os.X_OK):result['output']=subprocess.run([str(target)],capture_output=True,text=True).stdout
        print(json.dumps(result,sort_keys=True))
    elif scope=='unsafe-and-corrupt':
        cases=[]
        bad=root/'bad.bundle'
        for name in ['../escape','/absolute','safe/../../escape','..\\escape']:
            with zipfile.ZipFile(bad,'w') as archive:archive.writestr(name,b'escape')
            destination=root/('unsafe-'+str(len(cases)))
            verify=invoke('verify',bad);extract=invoke('extract',bad,destination)
            cases.append({'case':name,'verify_rejected':verify.returncode!=0,'extract_rejected':extract.returncode!=0})
        with zipfile.ZipFile(bad,'w') as archive:
            info=zipfile.ZipInfo('link');info.create_system=3;info.external_attr=(stat.S_IFLNK|0o777)<<16;archive.writestr(info,b'../escape')
        verify=invoke('verify',bad);extract=invoke('extract',bad,root/'link-destination')
        cases.append({'case':'symlink','verify_rejected':verify.returncode!=0,'extract_rejected':extract.returncode!=0})
        for label,data in [('garbage',b'not an archive'),('truncated',first.read_bytes()[:20] if first.exists() else b'')]:
            bad.write_bytes(data);destination=root/label;verify=invoke('verify',bad);extract=invoke('extract',bad,destination)
            cases.append({'case':label,'verify_rejected':verify.returncode!=0,'extract_rejected':extract.returncode!=0})
        print(json.dumps({'valid_verified':created.returncode==0 and invoke('verify',first).returncode==0,'cases':cases,'escaped_file_absent':not (root/'escape').exists()},sort_keys=True))
    elif scope=='no-overwrite':
        archive=root/'existing.bundle';archive.write_bytes(b'archive sentinel');archive_before={'data':archive.read_bytes(),'mode':stat.S_IMODE(archive.stat().st_mode)};invoke('create',source,archive)
        destination=root/'existing';destination.mkdir();(destination/'SKILL.md').write_bytes(b'file sentinel');before=tree(destination)
        invoke('extract',first,destination)
        after=tree(destination)
        print(json.dumps({'valid_created':created.returncode==0,'archive_preserved':archive.read_bytes()==archive_before['data'] and stat.S_IMODE(archive.stat().st_mode)==archive_before['mode'],'destination_preserved':all(after.get(name)==entry for name,entry in before.items())},sort_keys=True))
    else:raise ValueError(scope)
