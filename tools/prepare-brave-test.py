"""Copy encrypted Brave cookies without querying or displaying cookie values."""

import os
from contextlib import closing
from pathlib import Path
import re
import sqlite3
import subprocess
import sys
import tempfile


def copy_cookies(source_profile, target_profile):
    source_profile = Path(source_profile).resolve()
    target_profile = Path(target_profile).resolve()
    if source_profile == target_profile:
        raise ValueError('The test profile must differ from the normal profile.')
    source = next((source_profile / name for name in ('Network/Cookies', 'Cookies')
                   if (source_profile / name).is_file()), None)
    if source is None:
        raise FileNotFoundError('No cookies database found in the normal Brave profile.')
    target = target_profile / source.relative_to(source_profile)
    target.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(prefix='.cookies-', dir=target.parent)
    os.close(descriptor)
    try:
        # SQLite's backup API includes committed WAL data while normal Brave
        # stays open. Cookie rows and encrypted values are never queried.
        with closing(sqlite3.connect(source.as_uri() + '?mode=ro', uri=True, timeout=5)) as original:
            with closing(sqlite3.connect(temporary)) as snapshot:
                original.backup(snapshot)
        # Only call this with the destination browser stopped.
        for suffix in ('-wal', '-shm', '-journal'):
            Path(str(target) + suffix).unlink(missing_ok=True)
        os.replace(temporary, target)
    finally:
        Path(temporary).unlink(missing_ok=True)


def main():
    target_root = Path(sys.argv[1]).resolve()
    pattern = re.escape('--user-data-dir=' + str(target_root)) + r'(?:\s|$)'
    running = subprocess.run(['/usr/bin/pgrep', '-f', pattern], capture_output=True)
    if running.returncode == 0:
        print('The test browser is already open; cookies will sync next time it is fully closed.')
        return
    if running.returncode != 1:
        raise RuntimeError('Could not check whether the test browser is running.')
    normal = Path.home() / 'Library/Application Support/BraveSoftware/Brave-Browser/Default'
    copy_cookies(normal, target_root / 'Default')
    print('Copied encrypted cookies from normal Brave into the test profile.')


if __name__ == '__main__':
    main()
