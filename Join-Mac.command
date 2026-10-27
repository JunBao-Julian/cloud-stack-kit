#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")"
exec /bin/bash macos/bootstrap.sh join
