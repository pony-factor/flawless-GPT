#!/bin/bash
set -euo pipefail

app_source="$(cd "$(dirname "$0")/.." && pwd)"
extension_id=""
repository="PDF-magic/opener"
install_app=false
while [ "$#" -gt 0 ]; do
  case "$1" in
    --extension-id) extension_id="$2"; shift 2 ;;
    --repo) repository="$2"; shift 2 ;;
    --install) install_app=true; shift ;;
    *) printf 'Unknown option: %s\n' "$1" >&2; exit 2 ;;
  esac
done
if ! [[ "$extension_id" =~ ^[a-p]{32}$ ]]; then
  printf 'Pass --extension-id with the connector ID shown in Brave.\n' >&2
  exit 2
fi
if ! [[ "$repository" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]]; then
  printf 'Pass --repo owner/repository.\n' >&2
  exit 2
fi
build_dir="$app_source/.build"
bundle="$build_dir/Studio Chat Dispatcher.app"
mkdir -p "$bundle/Contents/MacOS" "$bundle/Contents/Resources/runtime"
xcrun swiftc -swift-version 5 -framework AppKit "$app_source/macos/Dispatcher.swift" -o "$bundle/Contents/MacOS/StudioChatDispatcher"
xcrun swift "$app_source/macos/Icon.swift" "$build_dir/AppIcon.iconset"
iconutil -c icns "$build_dir/AppIcon.iconset" -o "$bundle/Contents/Resources/AppIcon.icns"
ditto "$app_source/companion" "$bundle/Contents/Resources/runtime/companion"
ditto "$app_source/extension" "$bundle/Contents/Resources/runtime/extension"
python3 - "$bundle/Contents/Info.plist" "$extension_id" "$repository" <<'PY'
import plistlib,sys
from pathlib import Path
info={
 'CFBundleIdentifier':'link.wooten.studio.chat-dispatcher',
 'CFBundleName':'Studio Chat Dispatcher',
 'CFBundleDisplayName':'Studio Chat Dispatcher',
 'CFBundleExecutable':'StudioChatDispatcher',
 'CFBundlePackageType':'APPL',
 'CFBundleShortVersionString':'0.1.0',
 'CFBundleVersion':'1',
 'CFBundleIconFile':'AppIcon',
 'LSMinimumSystemVersion':'13.0',
 'NSHighResolutionCapable':True,
 'DispatcherExtensionID':sys.argv[2],
 'DispatcherRepository':sys.argv[3],
}
Path(sys.argv[1]).write_bytes(plistlib.dumps(info))
PY
codesign --force --deep --sign - "$bundle"
if "$install_app"; then
  destination="$HOME/Applications/Studio Chat Dispatcher.app"
  mkdir -p "$HOME/Applications"
  if [ -e "$destination" ]; then
    existing_id=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$destination/Contents/Info.plist" 2>/dev/null || true)
    if [ "$existing_id" != 'link.wooten.studio.chat-dispatcher' ]; then
      printf 'Refusing to replace an unrelated application at %s\n' "$destination" >&2
      exit 1
    fi
    backup="$HOME/Applications/Studio Chat Dispatcher.backup-$(date +%Y%m%d-%H%M%S).app"
    mv "$destination" "$backup"
  fi
  ditto "$bundle" "$destination"
  printf 'Installed: %s\n' "$destination"
else
  printf 'Built: %s\n' "$bundle"
fi
