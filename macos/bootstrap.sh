#!/bin/bash
set -euo pipefail
[[ "$(uname -s)" == Darwin ]] || { echo 'This entrypoint requires macOS.' >&2; exit 1; }
[[ "$(id -u)" != 0 ]] || { echo 'Run as your normal login user, not with sudo.' >&2; exit 1; }
cd "$(dirname "$0")/.."
umask 077
if ! command -v node >/dev/null || ! node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=13)?0:1)'; then
    arch="$(uname -m)"
    if [[ "$arch" == arm64 ]]; then
        arch=arm64; sha=5ed4db0fcf1eaf84d91ad12462631d73bf4576c1377e192d222e48026a902640
    elif [[ "$arch" == x86_64 ]]; then
        arch=x64; sha=5ea50c9d6dea3dfa3abb66b2656f7a4e1c8cef23432b558d45fb538c7b5dedce
    else echo 'Unsupported Mac architecture.' >&2; exit 1; fi
    cache="$HOME/Library/Application Support/CloudStack/Tools"
    mkdir -p "$cache"; chmod 700 "$cache"
    name="node-v22.22.0-darwin-$arch"
    curl --fail --show-error --location --retry 2 --connect-timeout 20 --max-time 600 "https://nodejs.org/dist/v22.22.0/$name.tar.gz" -o "$cache/$name.tar.gz"
    [[ "$(shasum -a 256 "$cache/$name.tar.gz" | awk '{print $1}')" == "$sha" ]] || { echo 'Node checksum mismatch' >&2; exit 1; }
    tar -xzf "$cache/$name.tar.gz" -C "$cache"
    export PATH="$cache/$name/bin:$PATH"
fi
npm ci --ignore-scripts --no-audit --no-fund
node lib/guest.cjs "${1:-join}"
