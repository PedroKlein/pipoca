#!/bin/sh
# Installs pipoca from its GitHub release:
#
#   curl -fsSL https://pipoca.dev/install.sh | sh
#
# PIPOCA_VERSION picks a release (default: the latest), PIPOCA_BIN_DIR where
# pipoca goes (default: ~/.local/bin) and PIPOCA_RELEASES a mirror of
# https://github.com/PedroKlein/pipoca/releases/download. Arguments after
# `sh -s --` run as a pipoca command once it is installed.
#
# Everything is inside main, so a download cut short runs nothing.

set -eu

main() {
  releases="${PIPOCA_RELEASES:-https://github.com/PedroKlein/pipoca/releases/download}"
  bin_dir="${PIPOCA_BIN_DIR:-$HOME/.local/bin}"

  case "$(uname -s)" in
    Linux) os=linux ;;
    Darwin) os=darwin ;;
    *) fail "pipoca runs on Linux and macOS, not $(uname -s)" ;;
  esac

  case "$(uname -m)" in
    x86_64 | amd64) arch=x64 ;;
    aarch64 | arm64) arch=arm64 ;;
    *) fail "pipoca has no build for $(uname -m)" ;;
  esac

  command -v curl > /dev/null || fail "installing pipoca needs curl"

  version="${PIPOCA_VERSION:-$(latest)}"
  version="${version#v}"
  asset="pipoca-$os-$arch"
  base="$releases/v$version"

  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' EXIT

  echo "Downloading pipoca $version for $os-$arch"
  curl -fsSL -o "$tmp/$asset" "$base/$asset" || fail "no pipoca $version at $base/$asset"
  curl -fsSL -o "$tmp/SHA256SUMS" "$base/SHA256SUMS" || fail "no SHA256SUMS at $base"

  want="$(awk -v name="$asset" '$2 == name { print $1 }' "$tmp/SHA256SUMS")"
  got="$(sha256 "$tmp/$asset")"
  [ -n "$want" ] && [ "$want" = "$got" ] || fail "$asset doesn't match the release's SHA256SUMS"

  chmod +x "$tmp/$asset"
  mkdir -p "$bin_dir"
  # A running pipoca keeps its file busy, so the new one moves into place.
  mv "$tmp/$asset" "$bin_dir/pipoca"
  echo "Installed $bin_dir/pipoca"

  case ":$PATH:" in
    *":$bin_dir:"*) ;;
    *) echo "Add $bin_dir to your PATH to run pipoca from any shell." ;;
  esac

  # Sessions clone with git and Pi installs packages with npm.
  for tool in git npm; do
    command -v "$tool" > /dev/null || echo "Sessions on this machine need $tool, which isn't on your PATH. On Ubuntu: sudo apt-get install -y git nodejs npm"
  done

  if [ "$#" -gt 0 ]; then
    exec "$bin_dir/pipoca" "$@"
  fi
}

# GitHub sends /releases/latest on to the newest release's tag.
latest() {
  url="$(curl -fsSLI -o /dev/null -w '%{url_effective}' https://github.com/PedroKlein/pipoca/releases/latest)" ||
    fail "couldn't find the latest release; set PIPOCA_VERSION"
  echo "${url##*/}"
}

sha256() {
  if command -v sha256sum > /dev/null; then
    sha256sum "$1" | awk '{ print $1 }'
  else
    shasum -a 256 "$1" | awk '{ print $1 }'
  fi
}

fail() {
  echo "pipoca install: $1" >&2
  exit 1
}

main "$@"
