# Bumps the build number in version.js and stamps it with the current time (UTC, ISO 8601; the game shows it in the
# player's local time zone). Run before merging a change:  python3 tools/bump_version.py
import datetime, pathlib, re
p = pathlib.Path(__file__).resolve().parent.parent / 'version.js'
build = int(re.search(r'build: (\d+)', p.read_text()).group(1)) + 1 if p.exists() else 1
now = datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%dT%H:%MZ')
p.write_text(f"// Build stamp shown in the menus. Bumped by tools/bump_version.py with every change.\nexport const BUILD = {{ build: {build}, date: '{now}' }};\n")
print(f'build {build}, {now}')
