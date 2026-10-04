import importlib.util
import io
import json
from pathlib import Path
import struct
import subprocess
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]


def load(name):
    spec = importlib.util.spec_from_file_location(name, ROOT / "native" / f"{name}.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


host = load("host")
installer = load("install")


def git(repo, *args):
    return subprocess.run(["git", "-c", "core.hooksPath=/dev/null", "-C", str(repo), *args],
                          check=True, capture_output=True, text=True).stdout.strip()


class PublisherTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name).resolve()
        self.repo = self.base / "Research repository"
        self.remote = self.base / "remote.git"
        self.repo.mkdir()
        git(self.base, "init", "--bare", str(self.remote))
        git(self.repo, "init", "-b", "main")
        git(self.repo, "config", "user.name", "Test Author")
        git(self.repo, "config", "user.email", "test@example.com")
        (self.repo / "existing.md").write_text("Existing report\n")
        git(self.repo, "add", "existing.md")
        git(self.repo, "-c", "commit.gpgsign=false", "commit", "-m", "Fixture")
        git(self.repo, "remote", "add", "origin", str(self.remote))
        git(self.repo, "push", "-u", "origin", "main")
        self.origin = "chrome-extension://" + "a" * 32 + "/"
        self.config = {"repo": str(self.repo), "branch": "main", "origin": self.origin}
        self.message = {"action": "publish", "title": "Sample research report", "markdown": "# Sample research report\n\nFull text.\n",
                        "source": "https://chatgpt.com/c/example"}

    def test_publish_preserves_checkout_and_retry_is_idempotent(self):
        (self.repo / "existing.md").write_text("Staged edit\n")
        git(self.repo, "add", "existing.md")
        (self.repo / "existing.md").write_text("Unstaged edit\n")
        (self.repo / "untracked.md").write_text("Untracked\n")
        before = (git(self.repo, "status", "--porcelain"), git(self.repo, "diff", "--cached"), git(self.repo, "rev-parse", "HEAD"))
        result = host.handle(self.message, self.config, self.origin)
        self.assertTrue(result["ok"])
        self.assertFalse(result["unchanged"])
        self.assertEqual(git(self.remote, "show", "main:" + result["path"]), self.message["markdown"].strip())
        self.assertEqual(git(self.remote, "show", "main:existing.md"), "Existing report")
        self.assertEqual(before, (git(self.repo, "status", "--porcelain"), git(self.repo, "diff", "--cached"), git(self.repo, "rev-parse", "HEAD")))
        again = host.handle(self.message, self.config, self.origin)
        self.assertTrue(again["unchanged"])
        self.assertEqual(again["commit"], result["commit"])
        updated = host.handle({**self.message, "markdown": "# Sample research report\n\nRevised.\n"}, self.config, self.origin)
        self.assertEqual(updated["path"], result["path"])
        self.assertNotEqual(updated["commit"], result["commit"])

    def test_readable_names_use_conversation_for_generic_headings_and_handle_collisions(self):
        message = {**self.message, "title": "Executive Summary", "context": "DTC Bond Purchaser Tracking"}
        first = host.handle(message, self.config, self.origin)
        self.assertEqual(first["path"], "dtc-bond-purchaser-tracking.md")
        second = host.handle({**message, "source": "https://chatgpt.com/c/other", "markdown": "Another report"}, self.config, self.origin)
        self.assertNotEqual(second["path"], first["path"])
        # Identity must survive other imports and a new clone of the remote.
        revised = host.handle({**message, "markdown": "Revised report"}, self.config, self.origin)
        self.assertEqual(revised["path"], first["path"])
        self.assertTrue(host.handle({**message, "markdown": "Revised report"}, self.config, self.origin)["unchanged"])
        self.assertEqual(host.report_url("git@github.com:example/research.git", "main", "Markets/a b.md"),
                         "https://github.com/example/research/blob/main/Markets/a%20b.md")
        self.assertEqual(host.report_url("https://github.com/example/research.git", "topic/branch", "report.md"),
                         "https://github.com/example/research/blob/topic%2Fbranch/report.md")
        self.assertIsNone(host.report_url("/tmp/local.git", "main", "report.md"))

    def test_rejects_foreign_origin_paths_and_invalid_content(self):
        with patch.object(host, "publish") as publish:
            for message, caller in [(self.message, "other"), ({**self.message, "repo": "/other"}, self.origin),
                                    ({"action": "launch"}, self.origin)]:
                with self.assertRaises(host.PublishError):
                    host.handle(message, self.config, caller)
            publish.assert_not_called()
        for values in [{"markdown": ""}, {"title": ""}, {"source": "https://other.example/c/a"}, {"markdown": "x" * (host.MAX_REPORT + 1)}]:
            with self.assertRaises(host.PublishError):
                host.validate({**self.message, **values})

    def test_category_publish_and_invalid_paths(self):
        result = host.handle({**self.message, "category": "Markets/Ownership"}, self.config, self.origin)
        self.assertTrue(result["path"].startswith("Markets/Ownership/"))
        self.assertEqual(git(self.remote, "show", "main:" + result["path"]), self.message["markdown"].strip())
        self.assertTrue(host.handle({**self.message, "category": "Markets/Ownership"}, self.config, self.origin)["unchanged"])
        for category in ["../outside", "/absolute", "a//b", "a/./b", ".git", "a\\b", "a\nother"]:
            with self.assertRaises(host.PublishError):
                host.validate_category(category)
        with self.assertRaises(host.PublishError):
            host.handle({**self.message, "category": "existing.md"}, self.config, self.origin)

    def test_status_lists_tracked_categories(self):
        folder = self.repo / "Markets" / "Ownership"
        folder.mkdir(parents=True)
        (folder / "report.md").write_text("Fixture")
        git(self.repo, "add", "Markets")
        git(self.repo, "-c", "commit.gpgsign=false", "commit", "-m", "Category fixture")
        result = host.handle({"action": "status"}, self.config, self.origin)
        self.assertEqual(result["categories"], ["Markets", "Markets/Ownership"])
        self.assertEqual(result["contents"]["Markets/Ownership"], ["report.md"])

    def test_install_links_branch_and_self_tests_bridge(self):
        manifest = installer.install("a" * 32, "brave", self.repo, self.base / "Application Support")
        data = json.loads(manifest.read_text())
        self.assertEqual(data["allowed_origins"], [self.origin])
        launcher = Path(data["path"])
        config = json.loads(launcher.with_name("config.json").read_text())
        self.assertEqual(config, self.config)
        self.assertEqual(installer.probe_host(launcher, self.origin)["branch"], "main")
        with self.assertRaisesRegex(host.PublishError, "Link repository"):
            host.handle(self.message, {"app": "old.app", "origin": self.origin}, self.origin)

    def test_probe_rejects_invalid_native_response(self):
        response = subprocess.CompletedProcess([], 0, stdout=b"bad", stderr=b"")
        with patch.object(installer.subprocess, "run", return_value=response):
            with self.assertRaisesRegex(ValueError, "did not start correctly"):
                installer.probe_host(Path("/tmp/host"), self.origin)

    def test_push_failure_never_reports_success_or_force_pushes(self):
        original = host.git
        calls = []
        def intercept(repo, *args, **kwargs):
            calls.append(args)
            if args[0] == "push":
                raise subprocess.CalledProcessError(1, "git push")
            return original(repo, *args, **kwargs)
        with patch.object(host, "git", intercept):
            with self.assertRaisesRegex(host.PublishError, "Push was not confirmed"):
                host.handle(self.message, self.config, self.origin)
        self.assertFalse(any("--force" in call or "-f" in call for call in calls))
        self.assertEqual(git(self.remote, "rev-list", "--count", "main"), "1")


    def test_codex_personalization_preserves_unmanaged_agents_content(self):
        agents = self.base / "AGENTS.md"
        agents.write_text("Keep this line.\n")
        host.sync_codex_instructions("Use plain ASCII quotes.", True, destination=agents)
        text = agents.read_text()
        self.assertIn("Keep this line.", text)
        self.assertIn("Use plain ASCII quotes.", text)
        self.assertIn(host.CODEX_WEB_COAUTHOR, text)
        settings = host.read_codex_settings(destination=agents)
        self.assertEqual(settings["instructions"], "Use plain ASCII quotes.")
        self.assertTrue(settings["webCodexCoauthor"])
        host.sync_codex_instructions("Keep replies compact.", False, destination=agents)
        settings = host.read_codex_settings(destination=agents)
        self.assertEqual(settings, {"instructions": "Keep replies compact.", "webCodexCoauthor": False})
        self.assertEqual(agents.read_text().count(host.START), 1)

    def test_protocol_errors_return_framed_json(self):
        for request in [b"", struct.pack("=I", host.MAX_MESSAGE + 1), struct.pack("=I", 10) + b"{}"]:
            output = io.BytesIO()
            with patch.object(host.sys, "stdin") as stdin, patch.object(host.sys, "stdout") as stdout:
                stdin.buffer = io.BytesIO(request)
                stdout.buffer = output
                host.main()
            payload = output.getvalue()
            self.assertEqual(struct.unpack("=I", payload[:4])[0], len(payload[4:]))
            self.assertFalse(json.loads(payload[4:])["ok"])


class PublisherInstallTests(unittest.TestCase):
    def install(self, support):
        repo = support.parent / "research"
        repo.mkdir(exist_ok=True)

        def git_result(args, **kwargs):
            if args[-2:] == ["rev-parse", "--show-toplevel"]:
                value = str(repo.resolve())
            elif args[-1] == "HEAD":
                value = "main"
            else:
                value = "https://github.com/example/research.git"
            return subprocess.CompletedProcess(args, 0, stdout=value + "\n", stderr="")

        with patch.object(installer.subprocess, "run", side_effect=git_result), \
                patch.object(installer, "probe_host", return_value={"ok": True}):
            return installer.install("a" * 32, "brave", repo, support)

    def test_brave_registers_host_in_chrome_compatible_directory(self):
        with tempfile.TemporaryDirectory() as directory:
            support = Path(directory).resolve() / "Application Support"
            manifest = self.install(support)
            compatibility = support / "Google/Chrome/NativeMessagingHosts" / manifest.name
            self.assertTrue(compatibility.is_symlink())
            self.assertEqual(compatibility.resolve(), manifest.resolve())
            self.assertEqual(json.loads(compatibility.read_text())["allowed_origins"],
                             ["chrome-extension://" + "a" * 32 + "/"])

    def test_brave_preserves_existing_chrome_publisher_registration(self):
        with tempfile.TemporaryDirectory() as directory:
            support = Path(directory).resolve() / "Application Support"
            compatibility = support / "Google/Chrome/NativeMessagingHosts/org.research.publisher.json"
            compatibility.parent.mkdir(parents=True)
            compatibility.write_text('{"existing":true}\n')
            self.install(support)
            self.assertEqual(compatibility.read_text(), '{"existing":true}\n')


if __name__ == "__main__":
    unittest.main()
