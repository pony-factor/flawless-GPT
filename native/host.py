"""Publish a report to a linked Git remote without changing its local checkout."""
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import struct
import subprocess
import sys
import shutil
import tempfile
from urllib.parse import urlparse

MAX_MESSAGE = 8 * 1024 * 1024
MAX_REPORT = 4 * 1024 * 1024
MAX_PERSONALIZATION = 512 * 1024
START = "<!-- scm-toolkit-chatgpt-instructions:start -->"
END = "<!-- scm-toolkit-chatgpt-instructions:end -->"
CODEX_WEB_COAUTHOR = "Co-authored-by: Codex Web <noreply@openai.com>"
COAUTHOR_INSTRUCTION = (
    "When creating Git commits through web or GitHub tools, append this trailer after a blank line:\n"
    + CODEX_WEB_COAUTHOR
)



class PublishError(Exception):
    pass


def codex_agents_path():
    root = Path(os.environ.get("FLAWLESS_CODEX_HOME") or os.environ.get("CODEX_HOME") or "~/.codex").expanduser()
    return root / "AGENTS.md"


def managed_instruction_block(instructions, web_codex_coauthor):
    parts = [START]
    text = str(instructions or "").strip()
    if text:
        parts.append(text)
    if web_codex_coauthor:
        if text:
            parts.append("")
        parts.append(COAUTHOR_INSTRUCTION)
    parts.append(END)
    return "\n".join(parts)


def sync_codex_instructions(instructions, web_codex_coauthor, destination=None):
    path = Path(destination) if destination is not None else codex_agents_path()
    existing = path.read_text() if path.exists() else ""
    pattern = re.compile(re.escape(START) + r".*?" + re.escape(END), flags=re.DOTALL)
    unmanaged = pattern.sub("", existing).strip()
    include = bool(str(instructions or "").strip()) or bool(web_codex_coauthor)
    pieces = [piece for piece in (
        unmanaged,
        managed_instruction_block(instructions, web_codex_coauthor) if include else "",
    ) if piece]
    updated = "\n\n".join(pieces)
    if updated:
        updated += "\n"
    if updated != existing:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(updated)
    return path


def read_codex_settings(destination=None):
    path = Path(destination) if destination is not None else codex_agents_path()
    if not path.exists():
        return {"instructions": "", "webCodexCoauthor": False}
    match = re.search(re.escape(START) + r"(.*?)" + re.escape(END), path.read_text(), flags=re.DOTALL)
    if not match:
        return {"instructions": "", "webCodexCoauthor": False}
    body = match.group(1).strip()
    if body == COAUTHOR_INSTRUCTION:
        return {"instructions": "", "webCodexCoauthor": True}
    suffix = "\n\n" + COAUTHOR_INSTRUCTION
    if body.endswith(suffix):
        return {"instructions": body[:-len(suffix)].strip(), "webCodexCoauthor": True}
    return {"instructions": body, "webCodexCoauthor": False}


def _gpg_fingerprint(secret_key, gpg):
    result = subprocess.run(
        [gpg, "--batch", "--with-colons", "--import-options", "show-only", "--import"],
        input=secret_key, capture_output=True, text=True,
    )
    if result.returncode != 0:
        raise PublishError(result.stderr.strip() or "Unable to inspect the PGP secret key.")
    saw_secret = False
    for line in result.stdout.splitlines():
        fields = line.split(":")
        if fields and fields[0] in {"sec", "ssb"}:
            saw_secret = True
            continue
        if saw_secret and fields and fields[0] == "fpr" and len(fields) > 9 and fields[9]:
            return fields[9]
    raise PublishError("The supplied PGP material did not contain a secret signing key.")


def import_pgp_secret_key(secret_key):
    secret = str(secret_key or "").strip()
    if not secret:
        return None
    gpg = shutil.which("gpg")
    git_path = shutil.which("git")
    if not gpg:
        raise PublishError("GnuPG was not found on PATH.")
    if not git_path:
        raise PublishError("Git was not found on PATH.")
    fingerprint = _gpg_fingerprint(secret, gpg)
    imported = subprocess.run([gpg, "--batch", "--import"], input=secret, capture_output=True, text=True)
    if imported.returncode != 0:
        raise PublishError(imported.stderr.strip() or "Unable to import the PGP secret key.")
    for key, value in (
        ("user.signingkey", fingerprint),
        ("commit.gpgsign", "true"),
        ("gpg.format", "openpgp"),
    ):
        result = subprocess.run(
            [git_path, "config", "--global", "--replace-all", key, value],
            capture_output=True, text=True,
        )
        if result.returncode != 0:
            raise PublishError(result.stderr.strip() or f"Unable to configure {key}.")
    return fingerprint


def handle_codex(message):
    action = message.get("action")
    if action == "codex-settings-status":
        settings = read_codex_settings()
        return {"ok": True, "agentsPath": str(codex_agents_path()), **settings}
    if action != "sync-codex-settings":
        return None
    if set(message) != {"action", "instructions", "webCodexCoauthor", "pgpSecretKey"}:
        raise PublishError("Invalid Codex personalization request.")
    instructions = message["instructions"]
    coauthor = message["webCodexCoauthor"]
    secret = message["pgpSecretKey"]
    if (not isinstance(instructions, str) or not isinstance(coauthor, bool)
            or not isinstance(secret, str) or "\x00" in instructions or "\x00" in secret
            or len(instructions.encode()) > MAX_PERSONALIZATION
            or len(secret.encode()) > MAX_PERSONALIZATION):
        raise PublishError("Invalid or oversized Codex personalization settings.")
    path = sync_codex_instructions(instructions, coauthor)
    fingerprint = import_pgp_secret_key(secret)
    return {"ok": True, "agentsPath": str(path), "signingKey": fingerprint}




def git(repo, *args, input=None):
    environment = {**os.environ, "GIT_TERMINAL_PROMPT": "0"}
    return subprocess.run(
        ["git", "-c", "core.hooksPath=/dev/null", "-c", "protocol.ext.allow=never", "-C", str(repo), *args],
        input=input, text=True, capture_output=True, check=True, timeout=120, env=environment,
    ).stdout.strip()


def validate(message):
    title = message.get("title")
    markdown = message.get("markdown")
    source = message.get("source")
    if (not isinstance(title, str) or not title.strip() or len(title) > 500
            or not isinstance(markdown, str) or not markdown.strip()
            or len(markdown.encode()) > MAX_REPORT or not isinstance(source, str)
            or len(source) > 2048 or urlparse(source).scheme != "https"
            or urlparse(source).netloc != "chatgpt.com"):
        raise PublishError("Invalid or oversized report.")
    return title.strip(), markdown.rstrip() + "\n", source


def validate_category(category):
    if (not isinstance(category, str) or len(category) > 240
            or (category and any(not part or part.startswith(".")
                                or not re.fullmatch(r"[\w -]+", part, re.UNICODE)
                                for part in category.split("/")))):
        raise PublishError("Choose a valid repository category.")
    return category


def publish(message, config):
    title, markdown, source = validate(message)
    category = validate_category(message.get("category", ""))
    repo = Path(config["repo"])
    branch = config["branch"]
    try:
        remote = git(repo, "remote", "get-url", "origin")
        name = git(repo, "config", "user.name")
        email = git(repo, "config", "user.email")
        git(repo, "check-ref-format", "--branch", branch)
    except (OSError, subprocess.SubprocessError):
        raise PublishError("Configure origin and a Git author in the linked repository, then try again.") from None
    words = re.findall(r"[a-z0-9]+", title.lower())[:6]
    stem = "-".join(words) or "research-report"
    suffix = hashlib.sha256((source + "\n" + title).encode()).hexdigest()[:10]
    filename = f"{stem}-{suffix}.md"
    if category:
        filename = f"{category}/{filename}"
    # The temporary bare clone has its own index; it never stages or edits the linked checkout.
    with tempfile.TemporaryDirectory(prefix="research-publish-") as temp:
        clone = Path(temp) / "repository.git"
        try:
            git(Path(temp), "clone", "--bare", "--depth=1", "--single-branch", "--branch", branch, "--", remote, str(clone))
        except (OSError, subprocess.SubprocessError):
            raise PublishError("Could not fetch the linked branch. Check Git access and the connection, then retry.") from None
        parent = git(clone, "rev-parse", "HEAD")
        # A category must never traverse a tracked file, symlink, or submodule.
        parts = category.split("/") if category else []
        for index in range(len(parts)):
            path = "/".join(parts[:index + 1])
            entry = git(clone, "ls-tree", parent, "--", path)
            if entry and not entry.startswith("040000 tree "):
                raise PublishError("This category conflicts with a repository file. Choose another category.")
        git(clone, "read-tree", parent)
        blob = git(clone, "hash-object", "-w", "--stdin", input=markdown)
        git(clone, "update-index", "--add", "--cacheinfo", "100644", blob, filename)
        tree = git(clone, "write-tree")
        unchanged = tree == git(clone, "rev-parse", "HEAD^{tree}")
        commit = parent
        if not unchanged:
            topic = " ".join(title.split()[:4])
            commit = git(clone, "-c", f"user.name={name}", "-c", f"user.email={email}",
                         "commit-tree", tree, "-p", parent, "-m", f"📝 Add {topic} report")
            try:
                git(clone, "push", "--", "origin", f"{commit}:refs/heads/{branch}")
            except (OSError, subprocess.SubprocessError):
                raise PublishError("Push was not confirmed. Check Git access or branch rules, then retry; an identical report will not be duplicated.") from None
    return {"ok": True, "repository": repo.name, "branch": branch, "path": filename,
            "commit": commit, "unchanged": unchanged}


def handle(message, config, origin):
    if origin != config.get("origin") or not isinstance(message, dict):
        raise PublishError("Unknown extension.")
    codex_result = handle_codex(message)
    if codex_result is not None:
        return codex_result
    if not config.get("repo") or not config.get("branch"):
        raise PublishError("Use Link repository to update the local bridge for direct publishing.")
    if message == {"action": "status"}:
        git(Path(config["repo"]), "rev-parse", "--git-dir")
        directories = git(Path(config["repo"]), "ls-tree", "-r", "-d", "--name-only", "HEAD").splitlines()
        categories = []
        for directory in directories:
            try:
                categories.append(validate_category(directory))
            except PublishError:
                continue
        return {"ok": True, "repository": Path(config["repo"]).name, "branch": config["branch"], "categories": categories}
    if (set(message) not in ({"action", "title", "markdown", "source"},
                            {"action", "title", "markdown", "source", "category"})
            or message["action"] != "publish"):
        raise PublishError("Unsupported action.")
    return publish(message, config)


def main():
    try:
        header = sys.stdin.buffer.read(4)
        if len(header) != 4:
            raise PublishError("Missing message header.")
        length = struct.unpack("=I", header)[0]
        if not 0 < length <= MAX_MESSAGE:
            raise PublishError("Invalid message size.")
        raw = sys.stdin.buffer.read(length)
        if len(raw) != length:
            raise PublishError("Incomplete report message.")
        message = json.loads(raw)
        config = json.loads(Path(__file__).with_name("config.json").read_text())
        with Path(__file__).with_name("publish.lock").open("a") as lock:
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                raise PublishError("Another report is being added. Try again when it finishes.") from None
            result = handle(message, config, sys.argv[1] if len(sys.argv) > 1 else "")
    except PublishError as error:
        result = {"ok": False, "error": str(error)}
    except Exception:
        result = {"ok": False, "error": "Unable to publish. Check the linked repository and Git configuration, then retry."}
    payload = json.dumps(result).encode("utf-8")
    sys.stdout.buffer.write(struct.pack("=I", len(payload)) + payload)
    sys.stdout.buffer.flush()


if __name__ == "__main__":
    main()
