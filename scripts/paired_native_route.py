#!/usr/bin/env python3
"""Run the same native-route workload sequentially on a Git baseline and current tree.

This is fictional fixed-response preparation plus native playback, not a real
provider benchmark or an activated editor test. Existing output is never replaced.
"""
import argparse
import hashlib
import io
import json
import math
import os
from pathlib import Path, PurePosixPath
import subprocess
import sys
import tarfile
import tempfile


def git(repository, *arguments):
    return subprocess.check_output(['git', *arguments], cwd=repository, stderr=subprocess.PIPE)


def tree_hash(folder):
    digest=hashlib.sha256()
    for file in sorted(folder.rglob('*')):
        if file.is_symlink():
            raise RuntimeError('Refusing an extension/input identity containing a symbolic link: '+str(file))
        if file.is_file():
            relative=file.relative_to(folder).as_posix().encode()
            digest.update(len(relative).to_bytes(4,'big'));digest.update(relative)
            digest.update(hashlib.sha256(file.read_bytes()).digest())
    return digest.hexdigest()


def unpack(archive, destination):
    """Accept only regular files/directories; never links or archive path escapes."""
    with tarfile.open(fileobj=io.BytesIO(archive),mode='r:') as source:
        members=source.getmembers()
        for member in members:
            name=PurePosixPath(member.name)
            if name.is_absolute() or '..' in name.parts or not (member.isfile() or member.isdir()):
                raise RuntimeError('Unsafe baseline archive member: '+member.name)
            target=(destination/Path(*name.parts)).resolve()
            if target != destination and destination not in target.parents:
                raise RuntimeError('Baseline archive escapes its temporary checkout.')
        # All members were validated before writing; links/devices are refused.
        # filter="data" additionally hardens supported Python versions.
        options={'filter':'data'} if hasattr(tarfile,'data_filter') else {}
        source.extractall(destination,members=members,**options)


def workload_identity(repository):
    names=['scripts/native_route_browser.py','scripts/workflow-host.js','scripts/production-editor-io.js','scripts/fixtures/route-ready-output.js',
           'extension/review-capacity.js','extension/webview/review-capacity.js']
    files={name:hashlib.sha256((repository/name).read_bytes()).hexdigest() for name in names}
    files['scripts/fixtures/route-preparation/']=tree_hash(repository/'scripts/fixtures/route-preparation')
    return files


def validate_result(value, folder, samples, reopens):
    if value.get('failure') or value.get('pageErrors') or value.get('hostErrors'):
        raise RuntimeError('Native workload recorded an assertion, page or host failure: '+str(folder/'checks.json'))
    if value.get('externalProviderRequests') != 0 or value.get('controlledRequests') != 2:
        raise RuntimeError('Unexpected provider requests in '+str(folder/'checks.json'))
    if value.get('functions',0)<2 or value.get('events',0)<2 or len(value.get('checks',[]))<4:
        raise RuntimeError('The checked multi-function route did not complete.')
    expected={'navigation':2*(value['events']-1)*samples,'cachedHostReopen':reopens}
    for key,count in expected.items():
        data=value.get(key,{})
        if data.get('count')!=count or len(data.get('allMs',[]))!=count:
            raise RuntimeError('Incomplete measurement set: '+key)
        if any(not isinstance(number,(int,float)) or not math.isfinite(number) or number<0 for number in data['allMs']):
            raise RuntimeError('Invalid timing in '+key)
    for name in ['first-step','preview-return','first-write','second-write','approval-reject','rollback','rollback-watch','width-761','width-801']:
        image=folder/(name+'.png')
        if not image.is_file() or not image.stat().st_size:
            raise RuntimeError('Missing actual native screenshot: '+str(image))


def paired_metric(before,after,key):
    fields=['count','medianMs','p95Ms','maxMs']
    return {'before':{field:before[key].get(field) for field in fields},
            'after':{field:after[key].get(field) for field in fields},
            'changeMs':{field:after[key][field]-before[key][field] for field in fields[1:]
                        if before[key].get(field) is not None and after[key].get(field) is not None}}


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--baseline',default='0fc6f25',help='Git commit/ref to export without changing the working tree.')
    parser.add_argument('--current-extension',help='Explicit current/installed extension directory. Defaults to this repository\'s extension/.')
    parser.add_argument('--production-selection',action='store_true',help='Use the actual extension activation/selection/cache path in both arms.')
    parser.add_argument('--output',required=True,help='New local directory for before/after screenshots, logs and paired metrics.')
    parser.add_argument('--samples',type=int,default=3,choices=range(1,11))
    parser.add_argument('--reopens',type=int,default=20,choices=range(1,51))
    args=parser.parse_args()
    repository=Path(__file__).resolve().parent.parent
    output=Path(args.output).expanduser().resolve()
    result={'status':'failed','boundary':'Same fictional source/report and fixed responses through both production preparation paths and native renderers. Simulated editor transport; zero real provider requests. Not a real-model latency or Cursor activation benchmark.'}
    created=False
    try:
        output.mkdir(parents=True,exist_ok=False);created=True
        native=Path(os.environ.get('FLOWBOARD_EXTENSION_PATH','')).expanduser().resolve()
        if not os.environ.get('FLOWBOARD_EXTENSION_PATH') or not (native/'webview/flowboard.js').is_file():
            raise RuntimeError('Set FLOWBOARD_EXTENSION_PATH to the pinned unpacked native extension.')
        baseline=git(repository,'rev-parse','--verify','--end-of-options',args.baseline+'^{commit}').decode().strip()
        current=Path(args.current_extension).expanduser().resolve(strict=True) if args.current_extension else repository/'extension'
        if not (current/'package.json').is_file() or not (current/'extension.js').is_file():
            raise RuntimeError('The selected current extension directory is incomplete.')
        identity=workload_identity(repository)
        current_hash=tree_hash(current)
        repository_commit=git(repository,'rev-parse','HEAD').decode().strip()
        result.update(baselineCommit=baseline,currentCommit=repository_commit if current==repository/'extension' else None,
            driverRepositoryCommit=repository_commit,currentBuildKind='explicit-extension' if args.current_extension else 'working-tree',
            currentWorkingTree=git(repository,'status','--porcelain=v1').decode().splitlines(),
            currentExtension=str(current),currentExtensionHash=current_hash,
            nativePath=str(native),nativeVersion=json.loads((native/'package.json').read_text()).get('version'),
            nativeScriptHash=hashlib.sha256((native/'webview/flowboard.js').read_bytes()).hexdigest(),
            workloadHashes=identity,samples=args.samples,reopens=args.reopens)
        # This exact mkdtemp checkout alone is removed at exit. The user's
        # branch, worktree, native installation and output directories survive.
        with tempfile.TemporaryDirectory(prefix='flowboard-paired-native-') as directory:
            checkout=Path(directory).resolve()
            unpack(git(repository,'archive','--format=tar',baseline),checkout)
            if not (checkout/'extension/package.json').is_file():
                raise RuntimeError('The baseline has no compatible extension tree.')
            result['baselineExtensionHash']=tree_hash(checkout/'extension')
            runs={}
            for label,extension in [('before',checkout/'extension'),('after',current)]:
                folder=output/label
                command=[sys.executable,str(repository/'scripts/native_route_browser.py'),'--product-extension',str(extension),
                    '--output',str(folder),'--samples',str(args.samples),'--reopens',str(args.reopens)]
                if label=='before':command.append('--baseline')
                if args.production_selection:command.append('--production-selection')
                result.setdefault('commands',{})[label]=command
                environment=os.environ.copy();environment['FLOWBOARD_EXTENSION_PATH']=str(native)
                environment['FLOWBOARD_TRIAGE_EXTENSION_PATH']=str(extension)
                print('Running '+label+' native workflow…',flush=True)
                with (output/(label+'.log')).open('w') as log:
                    run=subprocess.run(command,cwd=repository,env=environment,stdout=log,stderr=subprocess.STDOUT)
                if run.returncode:
                    raise RuntimeError(f'{label} native workflow exited {run.returncode}; inspect {output/(label+".log")}. The next run was not started.')
                value=json.loads((folder/'checks.json').read_text())
                validate_result(value,folder,args.samples,args.reopens)
                if Path(value['product']).resolve()!=extension.resolve():
                    raise RuntimeError('The native workload used a different product tree.')
                if workload_identity(repository)!=identity or tree_hash(current)!=current_hash:
                    raise RuntimeError('The current product or shared workload changed during the pair; do not compare these timings.')
                runs[label]=value
            before,after=runs['before'],runs['after']
            if before['fixtureHashes']!=after['fixtureHashes'] or any(before[key]!=after[key] for key in ['functions','events','codeLines']):
                raise RuntimeError('Before and after did not use the same source/report and route shape.')
            result.update(status='passed',selectionRoute=after.get('selectionRoute'),beforeVersion=before['version'],afterVersion=after['version'],
                navigation=paired_metric(before,after,'navigation'),controllerReopen=paired_metric(before,after,'cachedHostReopen'),
                observedTargets={'before':before['targets'],'after':after['targets']},
                dataset={key:after[key] for key in ['functions','events','codeLines','fixtureHashes']},
                requests={'beforeFixed':before['controlledRequests'],'afterFixed':after['controlledRequests'],'external':0},
                screenshotDirectories={'before':str(output/'before'),'after':str(output/'after')},
                baselineKnownDefect='The baseline records its provisional-after-rollback watch label; all other workflow/navigation assertions remain active.',
                interpretation='Timing differences are observations, not a demonstrated universal speedup. Performance misses remain in observedTargets; controller reopening is not an OS/editor-host restart.')
    except (Exception,KeyboardInterrupt) as error:
        result['error']=str(error) or 'Interrupted.'
        print(result['error'],file=sys.stderr)
    finally:
        if created:(output/'paired-checks.json').write_text(json.dumps(result,indent=2)+'\n')
    if result['status']!='passed':return 1
    print(json.dumps({key:result[key] for key in ['status','baselineCommit','currentCommit','navigation','controllerReopen','observedTargets','screenshotDirectories']},indent=2))
    return 0


if __name__=='__main__':
    raise SystemExit(main())
