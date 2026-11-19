#!/usr/bin/env bash
# deploy/server/setup.sh - set up ONE host for the agents and the mock systems.
#
# Run it as root, on a fresh host. The host runs Ubuntu or Debian (apt), like the present host:
#
#   ./setup.sh [AGENT_NAME ...]
#
# AGENT_NAME is the name of one agent. The script makes one folder for each name. The names are optional.
# To add a folder later, run the script again with the new name.
#
# What the script does:
#   1. It stops at once, and changes nothing, when this host already runs the agents of the present host.
#   2. It installs Docker Engine with the compose plugin, and Caddy. It checks the vendor keys against pinned fingerprints.
#   3. It writes /etc/docker/daemon.json: the log limits, the loopback address as the default for published ports, and live-restore.
#   4. It makes the service user and the folders: one for each agent, one for the mock systems, and one for keys (mode 700).
#   5. It writes the main Caddyfile and the folder for the snippets of the agents, and it reloads Caddy.
#   6. It sets the firewall to TCP 22, 80 and 443 only.
#   7. It sets a size limit and a time limit for the journal.
#   8. It prints what it did.
#
# What the script does not do:
#   - It makes no key. It reads no secret. It writes no password.
#   - It starts no container. It builds no image.
#   - It never restarts Docker or a container while a container runs. A runtime keeps its jobs in memory, and a restart stops them.
#   - It sets no DNS record. It does not touch the SSH configuration.
#
# The script is safe to run again. A second run gives the same result. It prints "unchanged" for each step that has nothing to do.

set -euo pipefail
umask 022
export DEBIAN_FRONTEND=noninteractive

# --- Settings. A real host uses the defaults. A test sets AGENTS_HOST_ROOT to a folder, and the two names to its own user and group.
ROOT="${AGENTS_HOST_ROOT:-}"
SERVICE_USER="${AGENTS_HOST_USER:-agents}"
SERVICE_GROUP="${AGENTS_HOST_GROUP:-$SERVICE_USER}"
BASE="$ROOT/srv/agents"
# The folder that the main Caddyfile imports. The Caddyfile and this script must name the same folder.
SNIPPET_FOLDER=/etc/caddy/agents
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# --- The firewall opens these TCP ports and no other port.
OPEN_PORTS="22 80 443"

# --- Pinned fingerprints of the apt keys of the two vendors. They are public values.
# If a vendor changes its key, the script stops. Check the new fingerprint on the web site of the vendor, then change it here.
DOCKER_KEY_FPR=9DC858229FC7DD38854AE2D88D81803C0EBFCD88
CADDY_KEY_FPR=65760C51EDEA2017CEA2CA15155B6D79CA56EA34
CADDY_KEY_URL=https://dl.cloudsmith.io/public/caddy/stable/gpg.key

# --- The containers, the volumes and the folders of the agents on the present host. A test keeps these lists equal to the compose files in deploy/host.
PRESENT_CONTAINERS="agent-history-agent agent-history-service document-pipeline-agent document-pipeline-service audio-snippets-agent audio-snippets-service advocate-agent advocate-service"
PRESENT_VOLUMES="document-pipeline-state advocate-state"
PRESENT_FOLDERS="/opt/agent-history /opt/document-pipeline /opt/audio-snippets /opt/advocate"

CHANGED=0
UNCHANGED=0
FILE_CHANGED=0
APT_UPDATED=0
REFUSED=0

say() { printf 'setup: %s\n' "$*"; }
note_changed() { CHANGED=$((CHANGED + 1)); say "changed: $*"; }
note_same() { UNCHANGED=$((UNCHANGED + 1)); say "unchanged: $*"; }
refuse() { printf 'setup: refused: %s\n' "$*" >&2; REFUSED=1; exit 1; }

trap 'status=$?; if [ "$status" -ne 0 ] && [ "$REFUSED" = 0 ]; then printf "setup: stopped (exit %s). Fix the cause. The script is safe to run again.\n" "$status" >&2; fi' EXIT

# ensure_file PATH MODE [keep] < content
# Write the content to PATH when PATH is missing, differs, or has another mode. With "keep", save the old file as PATH.before-setup (one time).
ensure_file() {
  local path=$1 mode=$2 keep=${3:-} tmp
  tmp=$(mktemp)
  cat >"$tmp"
  FILE_CHANGED=0
  if [ -f "$path" ] && cmp -s "$tmp" "$path" && [ "$(stat -c '%a' "$path")" = "$mode" ]; then
    rm -f "$tmp"
    note_same "$path"
    return 0
  fi
  if [ "$keep" = keep ] && [ -f "$path" ] && [ ! -e "$path.before-setup" ]; then
    cp -p "$path" "$path.before-setup"
  fi
  install -D -m "$mode" "$tmp" "$path"
  rm -f "$tmp"
  FILE_CHANGED=1
  note_changed "wrote $path (mode $mode)"
}

# ensure_dir PATH MODE [OWNER]
# Make the folder with this mode. With OWNER (user:group), the folder belongs to OWNER.
ensure_dir() {
  local path=$1 mode=$2 owner=${3:-}
  if [ -d "$path" ]; then
    if [ "$(stat -c '%a' "$path")" = "$mode" ]; then
      note_same "folder $path (mode $mode)"
    else
      chmod "$mode" "$path"
      note_changed "folder $path has mode $mode now"
    fi
  else
    install -d -m "$mode" "$path"
    note_changed "made folder $path (mode $mode)"
  fi
  if [ -n "$owner" ]; then chown "$owner" "$path"; fi
}

have_package() {
  local state
  state=$(dpkg-query -W -f='${Status}' "$1" 2>/dev/null || true)
  [ "$state" = 'install ok installed' ]
}

apt_get() { apt-get -qq -o DPkg::Lock::Timeout=300 -y "$@"; }

# Read the package lists again. A new package source needs this before its packages can install.
apt_refresh() { apt_get update; APT_UPDATED=1; }

apt_update_once() {
  if [ "$APT_UPDATED" = 0 ]; then apt_refresh; fi
}

os_value() { sed -n "s/^$1=//p" "$ROOT/etc/os-release" | tr -d '"'; }

# --- Checks. They run first. They change nothing.

check_root_and_os() {
  [ "$(id -u)" -eq 0 ] || refuse 'run this script as root'
  [ -r "$ROOT/etc/os-release" ] || refuse 'there is no /etc/os-release'
  OS_ID=$(os_value ID)
  OS_CODENAME=$(os_value VERSION_CODENAME)
  case "$OS_ID" in
    ubuntu | debian) ;;
    *) refuse "this script needs Ubuntu or Debian (apt). This host runs '$OS_ID'." ;;
  esac
  [ -n "$OS_CODENAME" ] || refuse 'the OS release file has no codename'
  command -v apt-get >/dev/null 2>&1 || refuse 'apt-get is not available'
}

# Stop when this host runs the agents of the present host. The wrong host must not get this set-up.
check_not_the_present_host() {
  local found="" name containers="" volumes=""
  if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
    containers=$(docker ps -a --format '{{.Names}}')
    volumes=$(docker volume ls --quiet)
  fi
  for name in $PRESENT_CONTAINERS; do
    if grep -Fxq -- "$name" <<<"$containers"; then found="$found container:$name"; fi
  done
  for name in $PRESENT_VOLUMES; do
    if grep -Fxq -- "$name" <<<"$volumes"; then found="$found volume:$name"; fi
  done
  for name in $PRESENT_FOLDERS; do
    if [ -e "$ROOT$name" ]; then found="$found folder:$name"; fi
  done
  if [ -n "$found" ]; then
    printf 'setup: refused: this host runs the agents of the present host:%s\n' "$found" >&2
    printf 'setup: nothing was changed. Run this script on the new host.\n' >&2
    REFUSED=1
    exit 3
  fi
}

# Caddy needs TCP 80 and TCP 443. Stop when another program holds one of them.
check_web_ports() {
  local busy
  busy=$(ss -H -ltnp 2>/dev/null | awk '$4 ~ /:(80|443)$/ && $0 !~ /"caddy"/ { print $4 " " $NF }' || true)
  [ -z "$busy" ] || refuse "another program holds TCP 80 or 443: $busy"
}

# The firewall opens TCP 22 only for SSH. A session on another port would end when the firewall starts.
check_ssh_port() {
  local port=22 daemon_ports
  if [ -n "${SSH_CONNECTION:-}" ]; then read -r _ _ _ port <<<"$SSH_CONNECTION"; fi
  [ "$port" = 22 ] || refuse "this SSH session uses port $port, and the firewall opens port 22 only"
  daemon_ports=$(sshd -T 2>/dev/null | awk '$1 == "port" && $2 != 22 { print $2 }' || true)
  [ -z "$daemon_ports" ] || refuse "sshd listens on port $daemon_ports, and the firewall opens port 22 only"
}

check_agent_names() {
  local name
  for name in "$@"; do
    [[ $name =~ ^[a-z][a-z0-9-]{0,30}$ ]] || refuse "bad agent name '$name': use lower case letters, digits and hyphens, at most 31 characters"
    case "$name" in
      keys | mock-systems) refuse "the name '$name' is for the set-up itself" ;;
    esac
  done
}

# --- Packages.

install_prerequisites() {
  local missing="" pkg
  for pkg in ca-certificates curl gnupg; do
    if ! have_package "$pkg"; then missing="$missing $pkg"; fi
  done
  if [ -n "$missing" ]; then
    apt_update_once
    # shellcheck disable=SC2086
    apt_get install $missing
    note_changed "installed$missing"
  else
    note_same "packages ca-certificates, curl and gnupg"
  fi
}

# install_apt_key NAME URL FINGERPRINT
# Download an apt key. Install it only when its fingerprint is the pinned one.
install_apt_key() {
  local name=$1 url=$2 fingerprint=$3 tmp listing gnupg_home
  tmp=$(mktemp)
  gnupg_home=$(mktemp -d)
  curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 --max-time 60 --output "$tmp" "$url"
  listing=$(GNUPGHOME="$gnupg_home" gpg --batch --show-keys --with-colons "$tmp")
  rm -rf "$gnupg_home"
  if ! grep -Fq ":$fingerprint:" <<<"$listing"; then
    rm -f "$tmp"
    refuse "the key from $url does not have the fingerprint $fingerprint. Check the fingerprint on the web site of the vendor. Change it in this script if the vendor changed its key."
  fi
  ensure_file "$ROOT/etc/apt/keyrings/$name.asc" 644 <"$tmp"
  rm -f "$tmp"
}

# Docker keeps its containers when its daemon stops only with live-restore. The setting is in daemon.json (below).
daemon_json() {
  cat <<'EOF'
{
  "ip": "127.0.0.1",
  "live-restore": true,
  "log-driver": "json-file",
  "log-opts": {
    "max-size": "10m",
    "max-file": "3"
  }
}
EOF
}

ensure_docker() {
  local arch docker_was_installed=0 conflicts="" pkg daemon_changed=0
  if have_package docker-ce && have_package docker-compose-plugin; then docker_was_installed=1; fi
  # daemon.json comes first. On a new host, the daemon then starts with these settings.
  ensure_file "$ROOT/etc/docker/daemon.json" 644 keep < <(daemon_json)
  daemon_changed=$FILE_CHANGED
  if [ "$docker_was_installed" = 1 ]; then
    note_same "Docker Engine and the compose plugin are installed"
  else
    for pkg in docker.io docker-doc docker-compose docker-compose-v2 podman-docker containerd runc; do
      if have_package "$pkg"; then conflicts="$conflicts $pkg"; fi
    done
    [ -z "$conflicts" ] || refuse "these packages conflict with Docker Engine. Remove them first:$conflicts"
    install_apt_key docker "https://download.docker.com/linux/$OS_ID/gpg" "$DOCKER_KEY_FPR"
    arch=$(dpkg --print-architecture)
    ensure_file "$ROOT/etc/apt/sources.list.d/docker.list" 644 <<EOF
deb [arch=$arch signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/$OS_ID $OS_CODENAME stable
EOF
    apt_refresh
    apt_get install docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
    note_changed "installed Docker Engine and the compose plugin"
  fi
  ensure_service docker
  # A changed daemon.json needs a restart of Docker. A restart stops every container that runs without live-restore, and a job is in memory.
  if [ "$docker_was_installed" = 1 ] && [ "$daemon_changed" = 1 ]; then
    if [ -z "$(docker ps --quiet)" ]; then
      systemctl restart docker
      note_changed "restarted Docker for the new daemon.json (no container ran)"
    else
      say "pending: daemon.json changed, and containers run. Restart Docker when each runtime says free (RUNBOOK.md). Until then the old settings stay in force."
    fi
  fi
}

ensure_caddy() {
  if have_package caddy; then
    note_same "Caddy is installed"
    return 0
  fi
  install_apt_key caddy-stable "$CADDY_KEY_URL" "$CADDY_KEY_FPR"
  ensure_file "$ROOT/etc/apt/sources.list.d/caddy-stable.list" 644 <<'EOF'
deb [signed-by=/etc/apt/keyrings/caddy-stable.asc] https://dl.cloudsmith.io/public/caddy/stable/deb/debian any-version main
EOF
  apt_refresh
  apt_get install caddy
  note_changed "installed Caddy"
}

# ensure_service UNIT: enable the unit and start it, or say that it runs already.
ensure_service() {
  local unit=$1
  if [ "$(systemctl is-enabled "$unit" 2>/dev/null || true)" = enabled ] && systemctl is-active --quiet "$unit"; then
    note_same "service $unit is enabled and active"
  else
    systemctl enable --now "$unit"
    note_changed "service $unit is enabled and active"
  fi
}

# --- The service user and the folders.

ensure_user() {
  if getent passwd "$SERVICE_USER" >/dev/null; then
    note_same "user $SERVICE_USER exists"
  else
    useradd --system --user-group --create-home --home-dir "$BASE" --shell /bin/bash "$SERVICE_USER"
    note_changed "made the user $SERVICE_USER"
  fi
  if tr ' ' '\n' < <(id -nG "$SERVICE_USER") | grep -Fxq docker; then
    note_same "user $SERVICE_USER is in the group docker"
  else
    usermod --append --groups docker "$SERVICE_USER"
    note_changed "added the user $SERVICE_USER to the group docker"
  fi
}

ensure_layout() {
  local owner="$SERVICE_USER:$SERVICE_GROUP" name
  ensure_dir "$BASE" 750 "$owner"
  ensure_dir "$BASE/mock-systems" 750 "$owner"
  # The folder for keys. A key is made on this host, in this folder, and it never leaves the host. The script makes no key.
  ensure_dir "$BASE/keys" 700 "$owner"
  for name in "$@"; do
    ensure_dir "$BASE/$name" 750 "$owner"
  done
}

# --- Caddy.

ensure_caddyfile() {
  local source="$HERE/Caddyfile" target="$ROOT/etc/caddy/Caddyfile" verdict
  [ -f "$source" ] || refuse "there is no Caddyfile next to this script: $source"
  grep -Fxq "import $SNIPPET_FOLDER/*.snippet" "$source" || refuse "the Caddyfile does not import $SNIPPET_FOLDER/*.snippet"
  ensure_dir "$ROOT$SNIPPET_FOLDER" 755
  # Validate the new file before it replaces the old one. The snippets that are in the folder now are part of the check.
  if ! verdict=$(caddy validate --config "$source" --adapter caddyfile 2>&1); then
    refuse "caddy validate stops on the new Caddyfile or on a snippet in $SNIPPET_FOLDER: $verdict"
  fi
  ensure_file "$target" 644 keep <"$source"
  if [ "$FILE_CHANGED" = 1 ]; then
    if systemctl is-active --quiet caddy; then
      systemctl reload caddy
      note_changed "reloaded Caddy"
    fi
  fi
  ensure_service caddy
}

# --- The firewall: TCP 22, 80 and 443, and nothing else.

ensure_firewall() {
  local want="" port status added ufw_defaults="/etc/default/ufw" needs_apply=0
  if ! command -v ufw >/dev/null 2>&1; then
    apt_update_once
    apt_get install ufw
    note_changed "installed ufw"
  fi
  want=$(for port in $OPEN_PORTS; do printf 'ufw allow %s/tcp\n' "$port"; done | LC_ALL=C sort)
  status=$(ufw status verbose 2>/dev/null || true)
  added=$(ufw show added 2>/dev/null | grep '^ufw ' | LC_ALL=C sort || true)
  if [ "$(sed -n 1p <<<"$status")" != 'Status: active' ]; then needs_apply=1; fi
  if ! grep -Fq 'Default: deny (incoming), allow (outgoing)' <<<"$status"; then needs_apply=1; fi
  if [ "$added" != "$want" ]; then needs_apply=1; fi
  # IPv6 must go through the firewall too.
  if [ -f "$ROOT$ufw_defaults" ] && grep -q '^IPV6=no' "$ROOT$ufw_defaults"; then
    sed -i 's/^IPV6=no/IPV6=yes/' "$ROOT$ufw_defaults"
    needs_apply=1
  fi
  if [ "$needs_apply" = 0 ]; then
    note_same "firewall: TCP $OPEN_PORTS only"
    return 0
  fi
  ufw --force reset >/dev/null
  ufw default deny incoming >/dev/null
  ufw default allow outgoing >/dev/null
  for port in $OPEN_PORTS; do ufw allow "$port/tcp" >/dev/null; done
  ufw --force enable >/dev/null
  note_changed "firewall: TCP $OPEN_PORTS only, all other incoming traffic denied"
}

# --- The journal. Caddy and the Docker daemon log to the journal. The journal has a size limit and a time limit.

ensure_journal_limit() {
  ensure_file "$ROOT/etc/systemd/journald.conf.d/agents-host.conf" 644 <<'EOF'
[Journal]
SystemMaxUse=1G
SystemMaxFileSize=100M
MaxRetentionSec=1month
EOF
  if [ "$FILE_CHANGED" = 1 ]; then
    systemctl restart systemd-journald
    note_changed "restarted systemd-journald for the new limits"
  fi
}

report() {
  say "result: $CHANGED changed, $UNCHANGED unchanged"
  say "docker: $(docker --version)"
  say "compose: $(docker compose version --short)"
  say "caddy: $(caddy version | head -n 1)"
  say "service user: $SERVICE_USER (home and base folder $BASE)"
  say "keys: this script made no key. The folder $BASE/keys is for keys that you make on this host. It has mode 700."
  say "next: make the DNS records, then follow RUNBOOK.md"
}

main() {
  check_agent_names "$@"
  check_root_and_os
  check_not_the_present_host
  check_web_ports
  check_ssh_port
  if [ -n "$ROOT" ]; then say "test root: $ROOT"; fi
  install_prerequisites
  ensure_docker
  ensure_caddy
  ensure_user
  ensure_layout "$@"
  ensure_caddyfile
  ensure_firewall
  ensure_journal_limit
  report
}

main "$@"
