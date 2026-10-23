#!/bin/bash
set -euo pipefail

workspace_dir="$(cd -- "$(dirname -- "$0")" && pwd -P)"
workspace_id="$(printf '%s' "$workspace_dir" | /usr/bin/shasum -a 256)"
workspace_id="${workspace_id%% *}"
test_profile_dir="$HOME/Library/Application Support/Flawless ChatGPT/Brave Tests/$workspace_id"

if [[ ! -d '/Applications/Brave Browser.app' ]]; then
  printf 'Install Brave Browser in /Applications to use this launcher.\n'
  exit 1
fi

# Give each checkout its own browser data, without copying normal-profile data.
/usr/bin/open -na 'Brave Browser' --args \
  "--user-data-dir=$test_profile_dir" \
  "--disable-extensions-except=$workspace_dir" \
  "--load-extension=$workspace_dir" \
  --no-first-run \
  --no-default-browser-check \
  --new-window \
  'https://chatgpt.com/'
