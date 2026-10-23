import importlib.util
from contextlib import closing
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest.mock import patch


spec = importlib.util.spec_from_file_location(
    'prepare_brave_test', Path(__file__).resolve().parents[1] / 'tools/prepare-brave-test.py')
launcher = importlib.util.module_from_spec(spec)
spec.loader.exec_module(launcher)


class BraveTestProfileTests(unittest.TestCase):
    def test_backup_includes_committed_wal_without_changing_source(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            normal, target = root / 'normal', root / 'test'
            normal.mkdir()
            target.mkdir()
            settings = target / 'settings-fixture'
            settings.write_text('preserve')
            with closing(sqlite3.connect(normal / 'Cookies')) as source:
                source.execute('PRAGMA journal_mode=WAL')
                source.execute('CREATE TABLE fixture (value TEXT)')
                source.execute("INSERT INTO fixture VALUES ('synthetic encrypted bytes')")
                source.commit()
                launcher.copy_cookies(normal, target)
                self.assertEqual(source.execute('SELECT COUNT(*) FROM fixture').fetchone(), (1,))
            with closing(sqlite3.connect(target / 'Cookies')) as copied:
                self.assertEqual(copied.execute('SELECT * FROM fixture').fetchone(),
                                 ('synthetic encrypted bytes',))
            self.assertEqual(settings.read_text(), 'preserve')
            self.assertEqual((target / 'Cookies').stat().st_mode & 0o777, 0o600)

    def test_rejects_copying_into_source_profile(self):
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaises(ValueError):
                launcher.copy_cookies(directory, directory)

    def test_running_test_browser_skips_cookie_copy(self):
        with patch.object(launcher.sys, 'argv', ['launcher', '/tmp/test-profile']), \
             patch.object(launcher.subprocess, 'run') as process, \
             patch.object(launcher, 'copy_cookies') as copy:
            process.return_value.returncode = 0
            launcher.main()
            copy.assert_not_called()


if __name__ == '__main__':
    unittest.main()
