"""Remove only TensorV-owned containers left after a gateway failure."""

import argparse
from datetime import datetime, timezone
import json
import re
import subprocess

NAME = re.compile(r"tensorv-[a-f0-9]{32}\Z")


def cleanup(remove_all=False, max_age=90):
    listing = subprocess.run(
        ["docker", "ps", "-a", "--filter", "label=app=tensorv-sandbox", "--format", "{{.Names}}"],
        check=True, capture_output=True, text=True, timeout=10,
    )
    for name in listing.stdout.splitlines():
        if not NAME.fullmatch(name):
            continue
        details = subprocess.run(["docker", "inspect", name], capture_output=True,
                                 text=True, timeout=10)
        if details.returncode:
            continue
        container = json.loads(details.stdout)[0]
        if container.get("Config", {}).get("Labels", {}).get("app") != "tensorv-sandbox":
            continue
        created = datetime.fromisoformat(container["Created"].replace("Z", "+00:00"))
        age = (datetime.now(timezone.utc) - created).total_seconds()
        if remove_all or age > max_age:
            result = subprocess.run(["docker", "rm", "-f", name], capture_output=True,
                                    text=True, timeout=10)
            if result.returncode == 0:
                print(f"Removed orphan sandbox {name}", flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--all", action="store_true", help="Gateway stop hook: remove all owned containers")
    args = parser.parse_args()
    cleanup(remove_all=args.all)
