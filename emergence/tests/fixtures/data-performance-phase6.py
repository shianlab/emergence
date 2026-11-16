"""Bounded real worker benchmark; no network, synthetic data only."""
import ctypes, json, os, platform, subprocess, sys, time, pathlib, hashlib
root=pathlib.Path(__file__).resolve().parents[3]/'artifacts'/'code-data-phase6'/'data-performance'
root.mkdir(parents=True,exist_ok=True)
worker=pathlib.Path(__file__).resolve().parents[2]/'src'/'domains'/'data'/'worker.py'
results=[]
for n in [1000,10000,10001]:
    path=root/('rows-'+str(n)+'.csv');path.write_text('id,value\n'+''.join(f'{i:06},{i}\n' for i in range(n)),encoding='utf-8',newline='\n')
    digest=hashlib.sha256(path.read_bytes()).hexdigest()
    for repeat in range(3):
        start=time.perf_counter();request={'input':str(path),'sql':'SELECT SUM(CAST(value AS BIGINT)) AS total FROM data'}
        child=subprocess.Popen([sys.executable,'-I','-B','-X','utf8',str(pathlib.Path(__file__).with_name('data-memory-run.py')),str(worker)],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,env={'SystemRoot':os.environ['SystemRoot'],'PATH':str(pathlib.Path(sys.executable).parent),'TEMP':str(root),'TMP':str(root)},creationflags=0x08000000)
        try: output,error=child.communicate(json.dumps(request).encode(),timeout=30)
        except subprocess.TimeoutExpired: child.kill();child.communicate();raise
        memory=json.loads(error.decode().split('WORKER_MEMORY:')[-1])
        value=json.loads(output);expected=n*(n-1)//2
        passed=not value['ok'] and child.returncode!=0 if n>10000 else value['ok'] and value['result']['rows']==n and int(value['result']['query']['rows'][0][0])==expected
        assert hashlib.sha256(path.read_bytes()).hexdigest()==digest
        results.append({'rows':n,'repeat':repeat+1,'durationMs':round((time.perf_counter()-start)*1000),'peakWorkerRss':memory['peak'],'passed':passed,'exitCode':child.returncode,'outputBytes':len(output)})
        assert passed,str(value)[:500]
assert all(r['durationMs']<30000 and r['outputBytes']<512000 and r['peakWorkerRss'] is not None and r['peakWorkerRss']<512*1024**2 for r in results)
report={'passed':True,'environment':{'python':sys.version.split()[0],'platform':platform.platform(),'cpu':platform.processor(),'logicalCpus':os.cpu_count()},'scope':'Actual fixed Python worker, real CSV and DuckDB; one worker at a time (Windows venv redirector may add a launcher). Windows kernel peak working set measured inside actual worker interpreter. 10001 rows must reject, not truncate. No million-row claim.','results':results}
(root/'performance.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
print(json.dumps(report))
