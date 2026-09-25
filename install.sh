#!/usr/bin/env bash
# WebPulpit – instalator dla Ubuntu / Debian.
# Użycie:
#   sudo bash install.sh                   # instalacja albo aktualizacja
#   sudo bash install.sh --reset-password  # zmiana loginu/hasła
#   sudo bash install.sh --uninstall       # usunięcie usługi
#
# Zmienne (opcjonalnie, do instalacji bez pytań):
#   WP_USERNAME, WP_PASSWORD, WP_PORT (8443), WP_RUN_AS (root), WP_HTTPS (1/0)
set -euo pipefail

APP_DIR=/opt/webpulpit
SERVICE=webpulpit
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

c_green=$'\e[32m'; c_yellow=$'\e[33m'; c_red=$'\e[31m'; c_bold=$'\e[1m'; c_off=$'\e[0m'
say()  { echo "${c_green}==>${c_off} $*"; }
warn() { echo "${c_yellow}UWAGA:${c_off} $*"; }
die()  { echo "${c_red}BŁĄD:${c_off} $*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "Uruchom jako root: sudo bash install.sh"

MODE=install
case "${1:-}" in
  --reset-password) MODE=reset ;;
  --uninstall) MODE=uninstall ;;
  "" ) ;;
  *) die "Nieznana opcja: $1" ;;
esac

if [ "$MODE" = uninstall ]; then
  systemctl disable --now "$SERVICE" 2>/dev/null || true
  rm -f "/etc/systemd/system/$SERVICE.service"
  systemctl daemon-reload
  say "Usługa usunięta. Pliki aplikacji zostały w $APP_DIR (usuń ręcznie: rm -rf $APP_DIR)."
  exit 0
fi

# ---------- 1. Pakiety systemowe ----------
if [ "$MODE" = install ]; then
  say "Instaluję wymagane pakiety (może chwilę potrwać)…"
  export DEBIAN_FRONTEND=noninteractive
  # A single broken third-party repository (e.g. an old Steam or PPA entry) makes
  # "apt-get update" fail. That should not stop the installation.
  if ! apt-get update -y >/dev/null 2>/tmp/webpulpit-apt.log; then
    warn "apt-get update zgłosił błędy (zwykle przez stare/zepsute repozytorium):"
    grep -E '^(E|W):' /tmp/webpulpit-apt.log | sed 's/^/    /' || true
    warn "Kontynuuję instalację. Aby naprawić, usuń to repozytorium z /etc/apt/sources.list.d/"
  fi
  apt-get install -y ca-certificates curl git openssl unzip zip tar build-essential python3 >/dev/null \
    || die "Nie udało się zainstalować pakietów. Napraw repozytoria apt (patrz komunikaty wyżej) i uruchom ponownie."

  NODE_MAJOR=0
  if command -v node >/dev/null 2>&1; then
    NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
  fi
  if [ "$NODE_MAJOR" -lt 18 ]; then
    say "Instaluję Node.js 22 (NodeSource)…"
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null 2>&1 \
      || warn "Skrypt NodeSource zgłosił błąd (pewnie przez to samo repozytorium) – próbuję dalej."
    apt-get install -y nodejs >/dev/null || die "Nie udało się zainstalować Node.js."
    NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
    [ "$NODE_MAJOR" -ge 18 ] || die "Zainstalowany Node.js jest za stary ($(node -v 2>/dev/null)). Napraw repozytoria apt i uruchom ponownie."
  fi
  say "Node.js $(node -v)"

  # ---------- 2. Pliki aplikacji ----------
  mkdir -p "$APP_DIR"
  if [ "$SRC_DIR" != "$APP_DIR" ]; then
    say "Kopiuję aplikację do $APP_DIR…"
    rm -rf "$APP_DIR/public" "$APP_DIR/lib" "$APP_DIR/scripts"
    tar -C "$SRC_DIR" --exclude=./node_modules --exclude=./.git --exclude=./config.json --exclude=./certs -cf - . \
      | tar -C "$APP_DIR" -xf -
  fi
  cd "$APP_DIR"
  say "Instaluję zależności npm…"
  if [ -f package-lock.json ]; then
    npm ci --omit=dev --no-audit --no-fund >/dev/null
  else
    npm install --omit=dev --no-audit --no-fund >/dev/null
  fi
fi
cd "$APP_DIR"

# ---------- 3. Konfiguracja ----------
ask() { # ask "Pytanie" "domyślna" -> echo odpowiedź
  local answer
  read -r -p "$1 [$2]: " answer </dev/tty || true
  echo "${answer:-$2}"
}

CONFIG="$APP_DIR/config.json"
cfg_get() { node -e "try{const c=require('$CONFIG');const v=c[process.argv[1]];if(v!=null)console.log(typeof v==='object'?JSON.stringify(v):v)}catch{}" "$1"; }

if [ -f "$CONFIG" ] && [ "$MODE" = install ]; then
  say "Konfiguracja już istnieje – zostawiam login i hasło bez zmian."
  PORT="$(cfg_get port)"; PORT="${PORT:-8443}"
  RUN_AS="$(systemctl show -p User --value "$SERVICE" 2>/dev/null || true)"
  RUN_AS="${RUN_AS:-${WP_RUN_AS:-root}}"
  HTTPS_ON=0; [ -n "$(cfg_get https)" ] && [ "$(cfg_get https)" != "null" ] && HTTPS_ON=1
else
  if [ "$MODE" = reset ]; then
    PORT="$(cfg_get port)"; PORT="${PORT:-8443}"
    RUN_AS="$(systemctl show -p User --value "$SERVICE" 2>/dev/null || true)"; RUN_AS="${RUN_AS:-root}"
    HTTPS_ON=0; [ -n "$(cfg_get https)" ] && [ "$(cfg_get https)" != "null" ] && HTTPS_ON=1
  else
    echo
    echo "${c_bold}Konfiguracja WebPulpit${c_off}"
    DEFAULT_USER="${SUDO_USER:-root}"
    RUN_AS="${WP_RUN_AS:-$(ask 'Jako który użytkownik Linux ma działać panel (dostęp do plików i terminal)?' "$DEFAULT_USER")}"
    PORT="${WP_PORT:-$(ask 'Port' 8443)}"
    HTTPS_ON="${WP_HTTPS:-1}"
  fi
  id "$RUN_AS" >/dev/null 2>&1 || die "Użytkownik $RUN_AS nie istnieje"

  USERNAME="${WP_USERNAME:-$(ask 'Login do panelu' admin)}"
  PASSWORD="${WP_PASSWORD:-}"
  while [ -z "$PASSWORD" ]; do
    read -r -s -p "Hasło do panelu (min. 8 znaków): " P1 </dev/tty; echo
    read -r -s -p "Powtórz hasło: " P2 </dev/tty; echo
    if [ "${#P1}" -lt 8 ]; then warn "Hasło za krótkie."; continue; fi
    if [ "$P1" != "$P2" ]; then warn "Hasła się różnią."; continue; fi
    PASSWORD="$P1"
  done

  CERT_ENV=()
  if [ "$HTTPS_ON" = 1 ]; then
    CERT_ENV=(WP_CERT="$APP_DIR/certs/cert.pem" WP_KEY="$APP_DIR/certs/key.pem")
  else
    CERT_ENV=(WP_HTTPS=0)
  fi
  env WP_USERNAME="$USERNAME" WP_PASSWORD="$PASSWORD" WP_PORT="$PORT" "${CERT_ENV[@]}" node scripts/setup.js
fi

# ---------- 4. Certyfikat HTTPS (samopodpisany) ----------
PUBLIC_IP="$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="src") print $(i+1)}' | head -1 || true)"
[ -n "$PUBLIC_IP" ] || PUBLIC_IP="$(hostname -I 2>/dev/null | awk '{print $1}' || true)"
[ -n "$PUBLIC_IP" ] || PUBLIC_IP="127.0.0.1"
if [ "$HTTPS_ON" = 1 ] && [ ! -f "$APP_DIR/certs/cert.pem" ]; then
  say "Generuję certyfikat HTTPS dla $PUBLIC_IP…"
  mkdir -p "$APP_DIR/certs"
  openssl req -x509 -newkey rsa:2048 -nodes -days 3650 \
    -keyout "$APP_DIR/certs/key.pem" -out "$APP_DIR/certs/cert.pem" \
    -subj "/CN=WebPulpit $PUBLIC_IP" \
    -addext "subjectAltName=IP:$PUBLIC_IP,DNS:$(hostname),DNS:localhost" >/dev/null 2>&1
  chmod 600 "$APP_DIR/certs/key.pem"
fi

# Remember where the git checkout is and which commit is installed, so the panel
# can check for and install updates by itself (Aktualizacje).
if [ "$MODE" = install ] && [ -d "$SRC_DIR/.git" ] && command -v git >/dev/null 2>&1; then
  GIT="git -c safe.directory=* -C $SRC_DIR"
  COMMIT="$($GIT rev-parse HEAD 2>/dev/null || true)"
  BRANCH="$($GIT rev-parse --abbrev-ref HEAD 2>/dev/null || true)"
  printf '{"commit":"%s","branch":"%s","date":"%s"}\n' "$COMMIT" "$BRANCH" "$(date -Iseconds)" > "$APP_DIR/version.json"
  node -e '
    const fs = require("fs"); const f = process.argv[1];
    const c = JSON.parse(fs.readFileSync(f, "utf8")); c.sourceDir = process.argv[2];
    fs.writeFileSync(f, JSON.stringify(c, null, 2), { mode: 0o600 });
  ' "$CONFIG" "$SRC_DIR"
fi

RUN_GROUP="$(id -gn "$RUN_AS")"
chown "$RUN_AS:$RUN_GROUP" "$CONFIG"
chmod 600 "$CONFIG"
[ -d "$APP_DIR/certs" ] && chown -R "$RUN_AS:$RUN_GROUP" "$APP_DIR/certs"

# ---------- 5. Usługa systemd ----------
NODE_BIN="$(command -v node)"
CAPS=""
if [ "$RUN_AS" != root ] && [ "$PORT" -lt 1024 ]; then
  CAPS="AmbientCapabilities=CAP_NET_BIND_SERVICE"
fi
cat > "/etc/systemd/system/$SERVICE.service" <<EOF
[Unit]
Description=WebPulpit - pulpit serwera w przegladarce
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$RUN_AS
WorkingDirectory=$APP_DIR
ExecStart=$NODE_BIN $APP_DIR/server.js
Restart=always
RestartSec=3
Environment=NODE_ENV=production
$CAPS

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable "$SERVICE" >/dev/null 2>&1
systemctl restart "$SERVICE"

# ---------- 6. Zapora ----------
if command -v ufw >/dev/null 2>&1 && ufw status | grep -q "Status: active"; then
  say "Otwieram port $PORT w zaporze ufw…"
  ufw allow "$PORT/tcp" >/dev/null
fi

sleep 2
if ! systemctl is-active --quiet "$SERVICE"; then
  journalctl -u "$SERVICE" -n 30 --no-pager || true
  die "Usługa nie wystartowała – zobacz logi powyżej."
fi

PROTO=http; [ "$HTTPS_ON" = 1 ] && PROTO=https
echo
echo "${c_bold}${c_green}Gotowe!${c_off} Otwórz w przeglądarce:"
echo
echo "    ${c_bold}$PROTO://$PUBLIC_IP:$PORT${c_off}"
echo
if [ "$HTTPS_ON" = 1 ]; then
  echo "Przeglądarka pokaże ostrzeżenie o certyfikacie (jest samopodpisany)."
  echo "Kliknij „Zaawansowane” → „Przejdź do strony”. Połączenie i tak jest szyfrowane."
fi
echo "Jeśli strona się nie otwiera: w panelu Linode (Firewalls) zezwól na TCP $PORT."
echo
echo "Przydatne polecenia:"
echo "  systemctl status $SERVICE       # stan"
echo "  journalctl -u $SERVICE -f       # logi"
echo "  sudo bash $APP_DIR/install.sh --reset-password"
