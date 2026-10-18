#!/usr/bin/env bash
# End-to-end smoke test against a running dev server on a FRESH local DB.
# Dev mode logs emails ("[mail:dev] to=..." + link) instead of sending them; we grep links from $LOG.
#   LOG=/path/to/dev.log bash scripts/smoke.sh
set -euo pipefail
B=${BASE:-http://localhost:5173}
LOG=${LOG:?set LOG to the dev server log}
J=$(mktemp -d)
pass() { echo "✓ $*"; }
fail() { echo "✗ $*"; exit 1; }

link_for() { # $1=email $2=path-fragment → newest link mailed to that address that we haven't used yet (waits up to 5s)
  local l i
  for i in $(seq 1 25); do
    l=$(grep -A1 -F "to=$1 " "$LOG" | grep -oE "http://[^ ]*$2[^ ]*" | tail -1 || true)
    if [ -n "$l" ] && ! grep -qxF "$l" "$J/used-links" 2>/dev/null; then echo "$l" >> "$J/used-links"; echo "$l"; return; fi
    sleep 0.2
  done
  echo ""
}
post() { # $1=jar $2=path ...curl-args → prints status
  local jar=$1 path=$2; shift 2
  curl -s -o /dev/null -w "%{http_code}" -b "$J/$jar" -c "$J/$jar" -X POST "$B$path" "$@"
}
page() { local out; out=$(curl -s -b "$J/$1" "$B$2"); printf "%s" "$out"; }
# Rendered text without tags/React comment markers, for content checks.
text() { page "$1" "$2" | sed -e 's/<!-- -->//g' -e 's/<[^>]*>/ /g' -e "s/&#x27;/'/g" | tr -s ' '; }
check() { # $1=desc, rest = command; never aborts the run on a miss
  local d=$1; shift
  if "$@"; then pass "$d"; else echo "✗ $d"; FAILS=$((FAILS+1)); fi
}
FAILS=0
login_via() { # $1=jar $2=auth-url
  local path=${2#$B} token next="/"
  token=${path#/auth/}; token=${token%%\?*}
  case "$2" in *next=*) next=$(python3 -c "import urllib.parse,sys;print(urllib.parse.unquote(sys.argv[1].split('next=',1)[1]))" "$2");; esac
  post "$1" "/auth/$token" --data-urlencode "next=$next" >/dev/null
}

# 1. setup + admin login
check "setup rejects wrong key" bash -c "curl -s -X POST '$B/setup' -d setup_key=wrong -d name=x -d email=x@x.com | grep -q 'Wrong setup key'"
post admin /setup -d setup_key=dev-setup-key -d name=Taha -d email=taha@example.com -d group=Stompers -d timezone=America/Los_Angeles >/dev/null
L=$(link_for taha@example.com /auth/); [ -n "$L" ] || fail "no login link mailed"
login_via admin "$L"
sleep 0.3
if page admin /me | grep -q "Log your steps"; then pass "admin logged in, Today renders"; else echo "✗ admin logged in, Today renders"; FAILS=$((FAILS+1)); fi
if [ "$(curl -s -o /dev/null -w '%{http_code}' $B/setup)" = 302 ]; then pass "setup locked after first run"; else echo "✗ setup locked after first run"; FAILS=$((FAILS+1)); fi
T=${L#*/auth/}; T=${T%%\?*}
if curl -s -o /dev/null -w "%{redirect_url}" -X POST "$B/auth/$T" -d next=/ | grep -q expired; then pass "login link is single-use"; else echo "✗ login link is single-use"; FAILS=$((FAILS+1)); fi
check "unknown email: same response, no mail sent" bash -c "curl -s -X POST '$B/login' -d email=stranger@example.com | grep -q 'Check your inbox' && ! grep -qF 'to=stranger@example.com' '$LOG'"

# 2. invite 4 friends
for n in ali omar zaid sam; do
  post admin /group -d intent=invite -d "email=$n@example.com" >/dev/null
  I=$(link_for $n@example.com /invite/); [ -n "$I" ] || fail "no invite for $n"; LAST_INVITE=$I
  text admin "${I#$B}" | grep -q "This invite is for $n@example.com" || fail "no mismatch warning for wrong user"
  post $n "${I#$B}" -d name=${n^} >/dev/null
  login_via $n "$(link_for $n@example.com /auth/)"
  curl -s -o /dev/null -b "$J/$n" -c "$J/$n" "$I"
  page $n /me | grep -q "Log your steps" || fail "$n not in group"
done
pass "4 invites → confirm email → joined"
if text admin /group | grep -q "Members · 5"; then pass "group has 5 members"; else echo "✗ group has 5 members"; FAILS=$((FAILS+1)); fi
if text outsider "${LAST_INVITE#$B}" | grep -q "already used"; then pass "used invite link is dead"; else echo "✗ used invite link is dead"; FAILS=$((FAILS+1)); fi

# 3. manual step entry
TODAY=$(TZ=America/Los_Angeles date +%F)
log() { post $1 "/me" -d intent=manual -d date=$2 -d steps=$3; }
log admin $TODAY 12500 >/dev/null; log ali $TODAY 6100 >/dev/null; log omar $TODAY 15000 >/dev/null; log zaid $TODAY 9000 >/dev/null
if page admin / | grep -q "12,500"; then pass "logged steps show on leaderboard"; else echo "✗ logged steps show on leaderboard"; FAILS=$((FAILS+1)); fi
log ali $TODAY 7300 >/dev/null; if page admin / | grep -q "7,300"; then pass "overwrite works"; else echo "✗ overwrite works"; FAILS=$((FAILS+1)); fi
if curl -s -b "$J/ali" -X POST "$B/me" -d intent=manual -d date=2020-01-01 -d steps=1 | grep -q "today or yesterday"; then pass "old date rejected"; else echo "✗ old date rejected"; FAILS=$((FAILS+1)); fi
if curl -s -b "$J/ali" -X POST "$B/me" -d intent=manual -d date=$TODAY -d steps=999999 | grep -q "whole number"; then pass "absurd steps rejected"; else echo "✗ absurd steps rejected"; FAILS=$((FAILS+1)); fi
if page admin / | grep -q "not logged yet"; then pass "sam (no entry) shown as counts-as-0"; else echo "✗ sam (no entry) shown as counts-as-0"; FAILS=$((FAILS+1)); fi

# 4. skips
post sam "/?index" -d intent=skip -d date=$TODAY >/dev/null
if page sam / | grep -q "Skip claimed"; then pass "skip claimed"; else echo "✗ skip claimed"; FAILS=$((FAILS+1)); fi
post sam "/?index" -d intent=unskip -d date=$TODAY >/dev/null
if page sam / | grep -q "Use skip"; then pass "skip undone"; else echo "✗ skip undone"; FAILS=$((FAILS+1)); fi

# 5. admin correction + permissions
SAM_ID=$(page admin /group | grep -oE 'value="[0-9a-f-]{36}">Sam' | grep -oE '[0-9a-f-]{36}')
post admin /group -d intent=correct -d userId=$SAM_ID -d date=$TODAY -d steps=4000 >/dev/null
if text admin / | grep -q "4,000"; then pass "admin correction shows on leaderboard"; else echo "✗ admin correction"; FAILS=$((FAILS+1)); fi
if [ "$(curl -s -o /dev/null -w '%{http_code}' -b "$J/ali" $B/group)" = 302 ]; then pass "non-admin blocked from /group"; else echo "✗ non-admin blocked from /group"; FAILS=$((FAILS+1)); fi

# 6. other pages
if page admin /month | grep -q "Daily steps"; then pass "month view renders"; else echo "✗ month view renders"; FAILS=$((FAILS+1)); fi
if page admin /history | grep -q "All-time pot"; then pass "ledger renders"; else echo "✗ ledger renders"; FAILS=$((FAILS+1)); fi
if page ali /me | grep -q "How it works"; then pass "me renders"; else echo "✗ me renders"; FAILS=$((FAILS+1)); fi

post ali /logout >/dev/null
if [ "$(curl -s -o /dev/null -w '%{http_code}' -b "$J/ali" $B/)" = 302 ]; then pass "logout works"; else echo "✗ logout works"; FAILS=$((FAILS+1)); fi
[ $FAILS = 0 ] && echo "ALL GOOD" || { echo "$FAILS check(s) failed"; exit 1; }
