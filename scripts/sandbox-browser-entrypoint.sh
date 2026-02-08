#!/usr/bin/env bash
set -euo pipefail

export DISPLAY=:1
export HOME=/tmp/kirie-home
export XDG_CONFIG_HOME="${HOME}/.config"
export XDG_CACHE_HOME="${HOME}/.cache"

CDP_PORT="${KIRIE_BROWSER_CDP_PORT:-9222}"
VNC_PORT="${KIRIE_BROWSER_VNC_PORT:-5900}"
NOVNC_PORT="${KIRIE_BROWSER_NOVNC_PORT:-6080}"
ENABLE_NOVNC="${KIRIE_BROWSER_ENABLE_NOVNC:-1}"
HEADLESS="${KIRIE_BROWSER_HEADLESS:-0}"

mkdir -p "${HOME}" "${HOME}/.chrome" "${XDG_CONFIG_HOME}" "${XDG_CACHE_HOME}"

# Resolve Playwright's Chromium binary path
CHROMIUM_BIN="$(npx playwright-core install --dry-run chromium 2>/dev/null | grep -oP '(?<=chromium )[^ ]+' || true)"
if [[ -z "${CHROMIUM_BIN}" ]]; then
  # Fallback: find Chromium in Playwright's cache directory
  CHROMIUM_BIN="$(find /root/.cache/ms-playwright /home/*/.cache/ms-playwright 2>/dev/null -name 'chrome' -o -name 'chromium' | head -1 || true)"
fi
if [[ -z "${CHROMIUM_BIN}" ]]; then
  echo "ERROR: Playwright Chromium binary not found. Run: npx playwright-core install chromium" >&2
  exit 1
fi

Xvfb :1 -screen 0 1280x800x24 -ac -nolisten tcp &

if [[ "${HEADLESS}" == "1" ]]; then
  CHROME_ARGS=(
    "--headless=new"
    "--disable-gpu"
  )
else
  CHROME_ARGS=()
fi

if [[ "${CDP_PORT}" -ge 65535 ]]; then
  CHROME_CDP_PORT="$((CDP_PORT - 1))"
else
  CHROME_CDP_PORT="$((CDP_PORT + 1))"
fi

CHROME_ARGS+=(
  "--remote-debugging-address=127.0.0.1"
  "--remote-debugging-port=${CHROME_CDP_PORT}"
  "--user-data-dir=${HOME}/.chrome"
  "--no-first-run"
  "--no-default-browser-check"
  "--disable-dev-shm-usage"
  "--disable-background-networking"
  "--disable-features=TranslateUI"
  "--disable-breakpad"
  "--disable-crash-reporter"
  "--metrics-recording-only"
  "--no-sandbox"
)

"${CHROMIUM_BIN}" "${CHROME_ARGS[@]}" about:blank &

for _ in $(seq 1 50); do
  if curl -sS --max-time 1 "http://127.0.0.1:${CHROME_CDP_PORT}/json/version" >/dev/null; then
    break
  fi
  sleep 0.1
done

socat \
  TCP-LISTEN:"${CDP_PORT}",fork,reuseaddr,bind=0.0.0.0 \
  TCP:127.0.0.1:"${CHROME_CDP_PORT}" &

if [[ "${ENABLE_NOVNC}" == "1" && "${HEADLESS}" != "1" ]]; then
  x11vnc -display :1 -rfbport "${VNC_PORT}" -shared -forever -nopw -localhost &
  websockify --web /usr/share/novnc/ "${NOVNC_PORT}" "localhost:${VNC_PORT}" &
fi

wait -n
