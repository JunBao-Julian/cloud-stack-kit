#!/usr/bin/env python3
import datetime, os, pathlib, shutil, sqlite3, subprocess, tarfile, tempfile
from contextlib import closing
os.umask(0o077)
root=pathlib.Path('/var/backups/cloud-stack');root.mkdir(parents=True,exist_ok=True);root.chmod(0o700)
with tempfile.TemporaryDirectory(prefix='.stage-',dir=root) as tmp:
    stage=pathlib.Path(tmp)
    with (stage/'sub2api.dump').open('wb') as f:subprocess.run(['runuser','-u','postgres','--','pg_dump','-Fc','sub2api'],stdout=f,check=True)
    with closing(sqlite3.connect('file:/usr/local/s-ui/db/s-ui.db?mode=ro',uri=True)) as src,closing(sqlite3.connect(stage/'s-ui.db')) as dst:src.backup(dst)
    for src in ['/etc/sub2api.env','/opt/sub2api/data/config.yaml','/var/lib/cloud-stack/credentials.json','/var/lib/cloud-stack/config.json']:
        if pathlib.Path(src).exists():shutil.copyfile(src,stage/pathlib.Path(src).name)
    output=root/('cloud-stack-'+datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%d-%H%M%S')+'.tar.gz')
    with tarfile.open(output,'w:gz') as tar:
        for f in stage.iterdir():tar.add(f,arcname=f.name)
for f in sorted(root.glob('cloud-stack-*.tar.gz'),reverse=True)[7:]:
    if f.is_file() and not f.is_symlink() and f.parent==root:f.unlink()
print('BACKUP_OK')
