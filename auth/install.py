"""Install the local login service without writing credentials to disk."""
from pathlib import Path
import plistlib
import shutil
import subprocess
import os
import time
import argparse
import re

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--extension-id", action="append", help="Allow an additional installed extension ID; this checkout is detected automatically.")
args = parser.parse_args()
extension_ids = args.extension_id or []
if any(not re.fullmatch(r"[a-p]{32}", value) for value in extension_ids):
    parser.error("Each extension ID must contain exactly 32 letters from a to p.")

root = Path(__file__).resolve().parent
node = shutil.which("node")
if not node:
    raise SystemExit("Install Node.js before installing the GitHub login service.")
label = "com.flawless-chatgpt.auth"
agent = Path.home() / "Library" / "LaunchAgents" / f"{label}.plist"
logs = Path.home() / "Library" / "Logs" / "Flawless ChatGPT Auth"
agent.parent.mkdir(parents=True, exist_ok=True)
logs.mkdir(parents=True, exist_ok=True)
configuration = {
    "Label": label,
    "ProgramArguments": [node, str(root / "server.cjs")],
    "RunAtLoad": True,
    "KeepAlive": True,
    "ProcessType": "Background",
    "StandardOutPath": str(logs / "service.log"),
    "StandardErrorPath": str(logs / "error.log"),
}
if extension_ids:
    configuration["EnvironmentVariables"] = {"GITHUB_APP_EXTENSION_IDS": ",".join(extension_ids)}
subprocess.run(["launchctl", "bootout", f"gui/{os.getuid()}/{label}"],
               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
with agent.open("wb") as output:
    plistlib.dump(configuration, output)
agent.chmod(0o600)
for attempt in range(10):
    result = subprocess.run(["launchctl", "bootstrap", f"gui/{os.getuid()}", str(agent)],
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    if result.returncode == 0:
        break
    time.sleep(0.3)
else:
    raise SystemExit("Could not start the local login service. Retry the installer after the previous service stops.")
print("Local GitHub login service installed at http://127.0.0.1:8787.")
