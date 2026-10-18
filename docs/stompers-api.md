# Stompers API research

Checked 2026-10-17 against Android `com.stompers` 1.9.6, version code 143.

## Findings

The app uses React Native, Expo, and Hermes bytecode version 98.
Production reads go to https://api.stompers.com. Live updates use
Socket.IO at https://socket.stompers.com with the `websocket` transport.
Health uploads go to https://processor.stompers.com; they are writes, not
the source to poll for StompTally.

The client obtains a Firebase ID token with `getIdToken(user, forceRefresh)`.
It sends that token directly as the HTTP `Authorization` header value.
The inspected client does **not** add `Bearer ` to that value.
On a Firebase authentication rejection, it forces a refresh and retries once.
Capturing an ID token alone does not establish a way to refresh it later.

Real profile, friend-room, and current-game reads succeeded without an
Authorization header for the consenting test account. Its activity-feed and
widget readers returned HTTP 401. These observations apply to the tested
account and routes; they do not establish access to every account or route.

## Read routes recovered from call sites

All these routes use POST and a JSON body. The `data` shown in the Axios
call sites is the request body itself, not an extra JSON wrapper.

| Route | JSON body | Client function ID |
| --- | --- | --- |
| `/users/getProfileByUsername` | `{"username":"YOUR_USERNAME"}` | 47539 |
| `/users/getProfileByUid` | `{"uid":"USER_UID"}` | 47540, 48935 |
| `/rooms/getRoom` | `{"uid":"ROOM_UID"}` | 47536 |
| `/games/getRecentGamesByRoomUid` | `{"uid":"ROOM_UID","limit":10}` | 36957 |
| `/games/getGame` | `{"uid":"GAME_UID"}` | 36953, 47669 |

The app's recent-games reader uses `makeOptionalAuthAPIRequest`.
Its other readers listed here use `makeAuthAPIRequest`.
Client-side authentication requirements are not proof of server enforcement.

## Step totals

Decoded game objects contain these fields:

```text
uid, participants, participant_uids, active_participant_uids,
room_uids, starts_at, finishes_at, time_zone, state, game_type,
settings, game_step_counts, step_counts, placements, used_items
```

`game_step_counts` is a map indexed by participant UID. The game's `Level`
and `Ring` views read this map. `step_counts` is a separate map.
`getParticipantStepCountFromGame` reads a UID from a supplied count map.

The client also has `calculateGameStepCountForPlayer`, which applies
`used_items` to a step count. Its item handler applies increments,
decrements, and timed debuffs, unless `settings.no_items_mode` is enabled.
This supports using game totals for the scoreboard rather than health totals.
The exact relationship between server totals and locally predicted live totals
still needs comparison with a real game on the phone.

For integration, read the room's current game and fetch recent/cached games
by UID. Store the target user's `step_counts[userUid]` and
`game_step_counts[userUid]` separately. StompTally's agreed rule is to score
the higher of these two values, preserving fractional item-adjusted counts.
Use `starts_at`, `finishes_at`, and `time_zone` to validate which local day
the game represents. Do not assume every game is one calendar day.
Never turn a missing field or failed request into a zero-step entry.

## Live probes

### Real friend-room and current game

After the user added a friend, the physical phone displayed an active game.
The widget reader in Hermes function 40360 constructs the friend-room UID
as `userUid + "_friends"`. It posts `{room_uid, user_uid}` to
`/widgets/getGameSummaryWidget`; that read returned HTTP 401 without a token.

Unauthenticated `/rooms/getRoom` for the user's friend-room succeeded and
returned `current_game_uid`. Fetching that UID through `/games/getGame`
also succeeded. `/games/getRecentGamesByRoomUid` returned an empty list;
do not rely on that history reader to find an active game.

The active game spans `2026-10-17T07:00:00.000Z` through
`2026-10-18T07:00:00.000Z`, with timezone `America/Los_Angeles`.
Both `step_counts` and `game_step_counts` held 837 for the friend, matching
the visible scoreboard. Both held 0 for the test account while its phone
displayed 3. The cause of that mismatch is unknown; upload timing and local
prediction remain hypotheses. This API zero must not become a penalty entry
until synchronization and completed-game behavior have been verified.

### Initial probes with made-up IDs

No auth headers were sent. Each UID/username was
`stomptally-api-research-no-account`, not an existing account.

| Route | HTTP | Response |
| --- | --- | --- |
| `/games/getGame` | 404 | `{"message":"Game not found"}` |
| `/games/getRecentGamesByRoomUid` | 200 | `[]` |
| `/rooms/getRoom` | 404 | `{"message":"Room not found"}` |
| `/users/getProfileByUid` | 404 | `{"message":"User not found"}` |
| `/users/getProfileByUsername` | 404 | `{"message":"User not found"}` |

These are real HTTP observations. All field layouts and auth flows above
are static observations from the downloaded app, not captured account traffic.

## Phone capture and emulator

No Android phone or ADB client was available during the first static pass.
The APK declares `res/xml/network_security_config.xml`. Its decoded content is:

```xml
<network-security-config>
  <base-config cleartextTrafficPermitted="true" />
</network-security-config>
```

It declares no user CA trust anchors or certificate pins in that XML.
With Android 11+ and target SDK 36, user-installed proxy CAs are not trusted
by default. A normal Wi-Fi proxy plus a user CA can therefore fail HTTPS.
This is not proof that native code has no additional pinning.

Prefer the official Play Store app on a spare test phone. A rooted test
phone or suitable test emulator can trust a proxy CA as a system CA.
Do not change certificate trust on a daily-use phone for this check.
The APK also declares `com.pairip.application.Application`; repacking may
interact with its integrity/licensing checks and was not attempted.

Once a test phone is ready, capture only the Stompers API hosts. Open
the current game and history. Keep the ID token and any captures in a
private local file, never in this repository or the chat transcript.
Compare a completed game's counts with the app's visible results.
Remove the proxy setting and test CA after capture.

### Initial emulator attempt

Google Android Emulator 37.2.12 was run headlessly with the Android 11
(API 30) Google APIs x86_64 image. This image reports
`libndk_translation.so` as its native bridge and advertises ARM64 support.
ADB used private server port 5038; the only test target was `emulator-5556`.
`adb root` succeeded. Host KVM access was denied, so this run uses software
emulation, 2 GB RAM, and SwiftShader. The XAPK declares minimum SDK 30,
so this Android version meets its stated requirement.

**Runtime result: Android did not finish booting.** The first system process
crashed in `DeviceStorageMonitorService.check()` with a null `StorageManager`.
Install attempts made before boot completion failed because the package service
or storage manager was not ready. A later system process also died;
`com.android.phone`, System UI, Bluetooth, and Google Play services logged
`DeadSystemException`. A third system process began startup. The exact cause
of that later system death was not established. The boot-complete property
never became `1`, and retrieved screen images stayed black.

The emulator acceleration check reported KVM permission denial, and opening
`/dev/kvm` returned errno 13 (`Permission denied`). Administrator access is
also unavailable: `sudo -n true` reported the container's `no new privileges`
flag. An administrator must make KVM accessible to this container and its
user, or provide another Android device. Adding a group inside the container
alone is not established as sufficient.

The failed emulator, private proxy, and local controls were stopped. No APK
installation succeeded; Stompers was not launched, and there was no login.
ARM64 translation is advertised by the image but has not been tested with
Stompers. No app-specific integrity or certificate-pinning result is available.

### KVM-enabled retry

A later host ACL check showed `user:1000:rw-` on `/dev/kvm`.
The emulator acceleration check then returned success:
`KVM (version 12) is installed and usable.` The same Android 11 AVD
completed boot, and `install-multiple` succeeded for the base APK, ARM64,
and density splits. This supersedes the initial boot/install failure above.

First launch crashed with `SoLoaderDSONotFoundError` for `libreactnative.so`.
The installed package selected `primaryCpuAbi=arm64-v8a`, but its native
library directory was empty. SoLoader searched APK paths under `lib/x86_64`,
whereas the split contains 43 uncompressed ARM64 libraries. These original
libraries were extracted from the unchanged split and copied into the test
installation's `lib/arm64` directory using the rootable emulator. SELinux
contexts were restored. The APK was not repacked or re-signed.

After relaunch, the app displayed: "Check that Google Play is enabled on your
device and that you're using an up-to-date version before opening the app."
A native translation crash was also present in the crash buffer; further
stability has not been established. No login or API token was obtained.

An official Android 15 / API 35 Google Play x86_64 image was downloaded from
Google's SDK repository (`x86_64-35_r09.zip`, 1,762,061,559 bytes), checked
against its published size and checksum, and extracted. A separate
`stompers-play` AVD is prepared. The Android 11 emulator was stopped before
switching images. At that point the UID 1000 ACL entry was no longer present;
KVM open returned errno 13 again, and the Google Play AVD failed to start.
The cause of the ACL removal is unknown. Host KVM access must remain enabled
through the next attempt. The Google Play image's ARM support, login flow,
and proxy-certificate setup remain untested.

### Google Play emulator ready for user sign-in

After the host restored `user:1000:rw-`, KVM again checked as usable.
The prepared `stompers-play` Android 15 AVD started, reported boot completion
in about 46 seconds, and returned `sys.boot_completed=1`. Its native bridge
is `libndk_translation.so`; Play Store is installed as
`/product/priv-app/Phonesky/Phonesky.apk`. Stompers' official market link
opened the Google Play sign-in screen. That screen was retrieved through
the private control server and visually inspected. The Google Play AVD has
not yet installed Stompers or completed an account sign-in.

The host ACL entry disappeared again after startup, but the already-running
emulator remains usable. Its running KVM connection has not been lost.
Avoid stopping this instance before completing the next checks; another
launch may need the host grant restored. The cause is still unknown.

The localhost controls accept printable ASCII password symbols and preserve
literal `%s` sequences. Text is sent to ADB over stdin, rather than in host
process arguments. The server keeps no access logs; cross-origin control
requests were rechecked and returned 403. Login is the user's next action at
`http://127.0.0.1:8087`. Do not ask for passwords, verification codes, or
tokens in chat. No credentials or real Stompers traffic have been captured.

### After Google Play sign-in

The user completed Google Play sign-in. Opening the official Stompers listing
then showed "Your device isn't compatible with this version" and no install
button. The exact Play Store exclusion criterion is unknown. The downloaded
APK manifest declares no explicit `uses-feature` entries; the emulator's
CPU ABI list is `x86_64,arm64-v8a` and its native bridge is enabled.

Installing the existing 1.9.6 APK and matching splits through ADB succeeded
on this Android 15 image. Launch failed before the login screen with
`SoLoaderDSONotFoundError: couldn't find DSO to load: libreactnative.so`.
SoLoader again searched split APK directories under `lib/x86_64`; the
installed app's native directory is `lib/arm64`, matching the ARM64 split.
The earlier root-only library extraction workaround cannot be applied through
ADB here: `adb root` returned "adbd cannot run as root in production builds".
No APK was repacked, re-signed, or patched during this attempt.

Google account sign-in did not establish a working Stompers installation,
Stompers authentication, or a token. The Google account remains signed in
on the test emulator. The next smallest API check requires the user's
Stompers username or room/group invite link, so the recovered read routes
can be tested with a real consenting account/group rather than made-up IDs.
Unauthenticated access to real step data remains unproven.

### Physical phone connected

Wi-Fi ADB pairing and connection succeeded on the user's Titan 2, running
Android 16 / API 36. Commands target its explicit network serial through
the private ADB server on port 5038. Stompers 1.9.6 / version code 143 was
already installed and opens successfully on this ARM phone. The stopped
emulator and removed phone web route were not restarted.

The app's profile screen identified the user's test account as `@stomptally`.
An unauthenticated POST to `/users/getProfileByUsername` with that username
returned a real profile UID and profile fields. This establishes that this
specific real profile read succeeds without a token; it does not establish
public access to games or step counts.

The recovered `/users/getUserActivityFeed` reader sends a POST body containing
`userUid`, `limit`, and feed-selection/pagination options. A limited read for
the same account's UID without a token returned HTTP 401. No current Firebase
ID token for that account appeared in its own process logs; other app logs
were not inspected. The app's home screen showed 2 steps at inspection time,
but that count has not yet been retrieved or matched through the API.

ADB runs as the ordinary shell user and no `su` executable was found.
No root request, certificate installation, proxy setting, account linking,
friend request, or app-data change was made on the physical phone. Its home
screen asks for a first friend; a real room/group link is still needed to
test the recovered room/game readers against the intended group.

### Temporary HTTPS phone controls

The phone controls are reverse-proxied through the dedicated Caddy host at
https://phone.mm.khome.dev/. The backend remains bound to
`127.0.0.1:8087`; no firewall port was opened. A separate HTTP Basic
username/password protects the page, screens, and controls over HTTPS.
The password was generated for the user and is not stored in this repository.
Caddy stores its bcrypt hash and removes the Authorization header before
forwarding to the local backend.

The route is first in `srv0.routes`, matches only `phone.mm.khome.dev`,
and forwards directly to the loopback control server without a path prefix.
Its Caddy ID is
`stomptally-test-phone`. Existing routes were preserved. This is a temporary
runtime route; `/etc/caddy/Caddyfile` was not edited, so a Caddyfile reload
may remove it. Remove this route through the local Caddy admin API with
`DELETE /id/stomptally-test-phone` after capture.

The control server uses `--public-origin https://phone.mm.khome.dev`
and relative fetch URLs. Screen and action requests use `/screen` and
`/action` on that host. HTTP Basic authentication is enforced by Caddy,
not that flag.
Host checks, the exact public Origin, and the in-memory control key remain
required for actions. TLS verification passed; anonymous requests returned
401, authenticated page/screens returned 200, foreign-origin actions returned
403, and authenticated invalid actions returned 400 without issuing ADB input.

The private mitmproxy instance listens on `127.0.0.1:8086`. It is configured to intercept
only the three Stompers hosts above. The capture addon handles HTTP
Authorization headers and client Socket.IO `subscribe.authToken` events;
that websocket handling was checked with synthetic packets, not account traffic.
The local control page listens on `127.0.0.1:8087` and targets only this
emulator. It supports screen images, taps, swipes, text, and four fixed keys.
It checks Host, Origin, and an in-memory control key, and keeps no access logs.
Wrong-host, cross-site screen, and unauthorized control checks returned 403.
The browser runtime is not installed on this host, so the page has not been
visually verified in a browser.

Host policy rejected the proposed certificate setup command with
`chmod.*/etc/.*`. No proxy CA was installed by that command. Do not work
around this refusal. The user can perform this one step once Android boots.
The following is the proposed setup for the **rootable Android 11 image**;
its mount and HTTPS trust still need runtime confirmation. Do not assume
these root-dependent commands work on the Google Play production image.
These paths describe this temporary run:

```bash
stompers_adb=(/home/taha/.kiro/crew/scratch/runtime-596fa8ee/stompers-emulator/sdk/platform-tools/adb -P 5038 -s emulator-5556)
"${stompers_adb[@]}" push /home/taha/.kiro/crew/scratch/runtime-596fa8ee/stompers-emulator/private-proxy/mitmproxy-ca-cert.pem /data/local/tmp/c8750f0d.0
"${stompers_adb[@]}" shell 'mkdir -p /data/local/tmp/stompers-cacerts; cp /system/etc/security/cacerts/* /data/local/tmp/stompers-cacerts/; cp /data/local/tmp/c8750f0d.0 /data/local/tmp/stompers-cacerts/; chmod 755 /data/local/tmp/stompers-cacerts; chmod 644 /data/local/tmp/stompers-cacerts/*; chcon -R u:object_r:system_file:s0 /data/local/tmp/stompers-cacerts; mount --bind /data/local/tmp/stompers-cacerts /system/etc/security/cacerts; ls -l /system/etc/security/cacerts/c8750f0d.0'
"${stompers_adb[@]}" reverse tcp:8086 tcp:8086
"${stompers_adb[@]}" shell settings put global http_proxy 127.0.0.1:8086
```

Install the CA before starting Stompers so its process inherits the modified
mount. If the app has already started, force-stop it and launch it again.
The proxy can read the emulator's Stompers traffic. Do not add this CA to
host trust or a daily-use phone. Undo inside the test emulator:

```bash
"${stompers_adb[@]}" shell settings put global http_proxy :0
"${stompers_adb[@]}" shell umount /system/etc/security/cacerts
"${stompers_adb[@]}" reverse --remove tcp:8086
```

The bind mount is temporary and disappears when the emulator stops.
No real account token or step-response capture has been obtained yet.

Socket subscription code emits `subscribe` with
`{authToken, subscriptionId, query}` and receives `queryUpdate` events.
The token is passed without a Bearer prefix here too. Exact query shapes
and live payloads remain unverified; HTTP polling is the smaller first step.

## Evidence and reproduction

The official site links https://play.google.com/store/apps/details?id=com.stompers.
The downloaded bundle came from APKPure's `d.apkpure.net` download host.
Its XAPK hash matches the hash listed by APKPure; publisher signature identity
was not independently checked.

```text
XAPK SHA-256: c5127e2f8fc1f5c5aa70d529b24432a78bb2d7f8e1a6519cc09a7b07c004362b
Base APK SHA-256: 3596491dbeaa01778f69af778bb1a027253cd42fd081db9965f95608aa5a8881
REA APK inventory: ev_60c240fbe3ef1a98398f5d2b1507c7e497e4e7b7bcff18ec29c89ccc0d902aa3
```

Code evidence is `assets/index.android.bundle` inside that base APK.
An in-memory Python decoder used the public Hermes 98 format/opcode table
from P1sec/hermes-dec. It verified the bundle SHA-1 footer and decoded all
49,589 function instruction streams without an unknown opcode or overrun.
That validates parsing boundaries, not complete semantic reconstruction.
The REA inventory ID covers the APK inventory, not the custom decoding.

Relevant function IDs and byte offsets in this exact bundle:

| Finding | Function ID | Byte offset |
| --- | --- | --- |
| Production host selection | 1069 | 9896959 |
| HTTP token header | 46099 | 16194126 |
| Firebase token retrieval | 40293 | 15443313 |
| Token returned unchanged | 46115 | 16201575 |
| Auth rejection and refresh | 40248 | 15431980 |
| Game view count choice | 24428 | 13125339 |
| Game count map getter | 24968 | 13246231 |
| Item-adjusted step calculation | 19750 | 12574579 |
| Item effects | 33575 | 14586603 |
| Socket subscription token | 46627 | 16300735 |

Temporary APKs and extracted assets are under the session scratch directory.
The first pass did not install or launch the app. StompTally's app code is unchanged.

Use the read-only probe script with your own username or room UID:

```bash
python3 scripts/stompers-probe.py profile --username YOUR_USERNAME
python3 scripts/stompers-probe.py history --room ROOM_UID --limit 3
python3 scripts/stompers-probe.py game --uid GAME_UID
```

The probe prints field names and game counts, and performs only the listed
read calls. If authentication is needed, set `STOMPERS_ID_TOKEN` locally;
the script sends it unchanged and never prints it. It does not refresh tokens.

Next checks: real profile/room IDs; a real current and completed game;
game day/timezone mapping; scoreboard agreement; auth expiry and refresh;
whether one consenting group member can read the whole group's counts.
