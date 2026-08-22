#!/bin/bash
# cast installer (macOS/Linux).
#
#   curl -fsSL https://aa-blinov.github.io/cast/install | bash
#
# (published from this file — see .github/workflows/pages.yml. `| bash`, not
# `| sh`: this script uses `set -o pipefail`, a bash/ksh extension that
# dash — /bin/sh on Debian/Ubuntu — rejects outright. Piping to an explicit
# interpreter ignores the #!/bin/bash shebang above, so the pipe itself has
# to name the right one.)
#
# Downloads the latest (or CAST_VERSION-pinned) platform-specific release
# tarball, unpacks it to ~/.cast/install, and symlinks bin/cast onto PATH.
set -euo pipefail

REPO="${CAST_REPO:-aa-blinov/cast}"
API_BASE="${CAST_API_BASE:-https://api.github.com}"
DOWNLOAD_BASE_OVERRIDE="${CAST_DOWNLOAD_BASE:-}"
INSTALL_DIR="${CAST_INSTALL_DIR:-$HOME/.cast/install}"
BIN_DIR="${CAST_BIN_DIR:-$HOME/.local/bin}"
MIN_NODE_MAJOR=22

case "$(uname -s):$(uname -m)" in
	Linux:x86_64|Linux:amd64) TARGET="linux-x64" ;;
	Linux:aarch64|Linux:arm64) TARGET="linux-arm64" ;;
	Darwin:x86_64|Darwin:amd64) TARGET="darwin-x64" ;;
	Darwin:arm64) TARGET="darwin-arm64" ;;
	*)
		printf '\033[31mUnsupported platform: %s %s. Supported targets: Linux x64/arm64 and macOS x64/arm64.\033[0m\n' "$(uname -s)" "$(uname -m)" >&2
		exit 1
		;;
esac

info() { printf '\033[36m%s\033[0m\n' "$1"; }
warn() { printf '\033[33m%s\033[0m\n' "$1"; }
err() { printf '\033[31m%s\033[0m\n' "$1" >&2; }

if ! command -v node >/dev/null 2>&1; then
	err "Node.js not found. cast's release bundle still needs Node.js ${MIN_NODE_MAJOR}+ installed — get it from https://nodejs.org or your package manager, then re-run this installer."
	exit 1
fi

NODE_MAJOR="$(node -e 'console.log(process.versions.node.split(".")[0])')"
if [ "$NODE_MAJOR" -lt "$MIN_NODE_MAJOR" ]; then
	err "Node.js ${MIN_NODE_MAJOR}+ required, found $(node -v). Upgrade Node.js and re-run this installer."
	exit 1
fi

if ! command -v curl >/dev/null 2>&1; then
	err "curl is required but wasn't found."
	exit 1
fi

if [ -n "${CAST_VERSION:-}" ]; then
	TAG="v${CAST_VERSION#v}"
	info "Installing cast ${TAG} (pinned via CAST_VERSION)..."
	if [ -n "$DOWNLOAD_BASE_OVERRIDE" ]; then
		ASSET_URL="${DOWNLOAD_BASE_OVERRIDE%/}/cast-${TAG#v}-${TARGET}.tar.gz"
		LEGACY_ASSET_URL="${DOWNLOAD_BASE_OVERRIDE%/}/cast-${TAG#v}.tar.gz"
	else
		ASSET_URL="https://github.com/${REPO}/releases/download/${TAG}/cast-${TAG#v}-${TARGET}.tar.gz"
		LEGACY_ASSET_URL="https://github.com/${REPO}/releases/download/${TAG}/cast-${TAG#v}.tar.gz"
	fi
else
	info "Looking up the latest cast release..."
	RELEASE_JSON="$(curl -fsSL "${API_BASE}/repos/${REPO}/releases/latest")"
	TAG="$(printf '%s' "$RELEASE_JSON" | grep -o '"tag_name": *"[^"]*"' | head -n1 | sed -E 's/.*"([^"]+)"$/\1/')"
	if [ -n "$DOWNLOAD_BASE_OVERRIDE" ]; then
		ASSET_URL="${DOWNLOAD_BASE_OVERRIDE%/}/cast-${TAG#v}-${TARGET}.tar.gz"
		LEGACY_ASSET_URL="${DOWNLOAD_BASE_OVERRIDE%/}/cast-${TAG#v}.tar.gz"
	else
		ASSET_URL="https://github.com/${REPO}/releases/download/${TAG}/cast-${TAG#v}-${TARGET}.tar.gz"
		LEGACY_ASSET_URL="https://github.com/${REPO}/releases/download/${TAG}/cast-${TAG#v}.tar.gz"
	fi
	if [ -z "$TAG" ]; then
		err "Couldn't find a release asset. Is https://github.com/${REPO}/releases populated yet?"
		exit 1
	fi
	info "Latest release: ${TAG}"
fi

WORK_DIR="$(mktemp -d)"
trap 'rm -rf "$WORK_DIR"' EXIT

info "Downloading ${ASSET_URL}..."
if ! curl -fsSL "$ASSET_URL" -o "$WORK_DIR/cast.tar.gz"; then
	if [ "$TARGET" = "linux-arm64" ]; then
		err "This release has no Linux ARM64 archive. A legacy Linux archive contains an x64 native PTY and cannot be used safely."
		exit 1
	fi
	warn "Platform-specific asset is unavailable; trying the legacy architecture-independent archive."
	ASSET_URL="$LEGACY_ASSET_URL"
	curl -fsSL "$ASSET_URL" -o "$WORK_DIR/cast.tar.gz"
fi

info "Installing to ${INSTALL_DIR}..."
rm -rf "$INSTALL_DIR"
mkdir -p "$(dirname "$INSTALL_DIR")"
tar -xzf "$WORK_DIR/cast.tar.gz" -C "$WORK_DIR"
mv "$WORK_DIR/cast" "$INSTALL_DIR"
chmod +x "$INSTALL_DIR/bin/cast"

mkdir -p "$BIN_DIR"
ln -sf "$INSTALL_DIR/bin/cast" "$BIN_DIR/cast"

INSTALLED_VERSION="$(node -e "console.log(require('$INSTALL_DIR/package.json').version)" 2>/dev/null || echo "unknown")"
info "cast ${INSTALLED_VERSION} installed."

# Open firewall for web UI (cast server --public uses 1337, factory UIs at /ui/* and /<name>/ on same port)
open_port() {
	local port="$1"
	if command -v ufw >/dev/null 2>&1; then
		if sudo -n ufw status >/dev/null 2>&1; then
			if ! sudo -n ufw status 2>&1 | grep -q "${port}/tcp.*ALLOW"; then
				info "Opening firewall port ${port}/tcp (ufw)..."
				sudo -n ufw allow "${port}/tcp" >/dev/null 2>&1 || warn "Could not open ${port}/tcp via ufw (try: sudo ufw allow ${port}/tcp)"
			fi
		elif [ "$(id -u)" -eq 0 ] && ufw status >/dev/null 2>&1; then
			if ! ufw status 2>&1 | grep -q "${port}/tcp.*ALLOW"; then
				info "Opening firewall port ${port}/tcp (ufw)..."
				ufw allow "${port}/tcp" >/dev/null 2>&1 || warn "Could not open ${port}/tcp via ufw"
			fi
		fi
	elif command -v firewall-cmd >/dev/null 2>&1; then
		if sudo -n firewall-cmd --state >/dev/null 2>&1; then
			info "Opening firewall port ${port}/tcp (firewalld)..."
			sudo -n firewall-cmd --add-port="${port}/tcp" --permanent >/dev/null 2>&1 || true
			sudo -n firewall-cmd --reload >/dev/null 2>&1 || true
		fi
	elif command -v iptables >/dev/null 2>&1 && [ "$(id -u)" -eq 0 ]; then
		if ! iptables -C INPUT -p tcp --dport "$port" -j ACCEPT >/dev/null 2>&1; then
			info "Opening firewall port ${port}/tcp (iptables)..."
			iptables -I INPUT -p tcp --dport "$port" -j ACCEPT 2>&1 | head -n 5 || true
		fi
	fi
}
for p in 1337; do open_port "$p"; done

case ":$PATH:" in
*":$BIN_DIR:"*) ;;
*)
	warn "${BIN_DIR} isn't on your PATH yet. Add this to your shell profile (~/.zshrc, ~/.bashrc, ...):"
	warn "  export PATH=\"${BIN_DIR}:\$PATH\""
	;;
esac

info "Run 'cast' to get started."
