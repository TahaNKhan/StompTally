"""mitmproxy addon: keep Stompers tokens private and record read shapes."""

import base64
import json
import os
from pathlib import Path
import time


HOSTS = {"api.stompers.com", "socket.stompers.com", "processor.stompers.com"}
READ_PATHS = {
    "/users/getProfileByUsername", "/users/getProfileByUid", "/rooms/getRoom",
    "/games/getRecentGamesByRoomUid", "/games/getGame",
}


def private_directory():
    directory = Path(os.environ["STOMPERS_CAPTURE_DIR"])
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    directory.chmod(0o700)
    return directory


def private_write(name, value):
    path = private_directory() / name
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    os.fchmod(fd, 0o600)
    with os.fdopen(fd, "w") as output:
        output.write(value)


def token_info(token):
    """Claims are unverified metadata, not proof of token validity."""
    try:
        encoded = token.split(".")[1]
        claims = json.loads(base64.urlsafe_b64decode(encoded + "=" * (-len(encoded) % 4)))
        return {
            "expires_at": claims.get("exp"),
            "provider": claims.get("firebase", {}).get("sign_in_provider"),
        }
    except (ValueError, IndexError, TypeError, AttributeError):
        return {"provider": "unknown"}


def save_token(token):
    if not token or "\r" in token or "\n" in token:
        return
    private_write("id-token.txt", token)
    private_write("token-info.json", json.dumps(token_info(token)))


def request(flow):
    if flow.request.host in HOSTS:
        save_token(flow.request.headers.get("Authorization", ""))


def websocket_message(flow):
    """Socket.IO also sends the ID token inside its subscribe event."""
    if flow.request.host != "socket.stompers.com" or not flow.websocket:
        return
    message = flow.websocket.messages[-1]
    if not message.from_client:
        return
    try:
        content = message.content.decode() if isinstance(message.content, bytes) else message.content
        if not content.startswith("42["):
            return
        event = json.loads(content[2:])
        if (isinstance(event, list) and len(event) > 1
                and event[0] == "subscribe" and isinstance(event[1], dict)):
            token = event[1].get("authToken")
            if isinstance(token, str):
                save_token(token)
    except (ValueError, UnicodeDecodeError, TypeError):
        pass


def shape(value):
    if isinstance(value, list):
        return {"count": len(value), "items": [shape(item) for item in value[:20]]}
    if not isinstance(value, dict):
        return {"type": type(value).__name__}
    result = {"fields": sorted(value)}
    for key in ("uid", "room_uid", "room_uids", "game_uid", "starts_at",
                "finishes_at", "time_zone", "state", "game_type"):
        if key in value:
            result[key] = value[key]
    for key in ("game_step_counts", "step_counts", "placements"):
        counts = value.get(key)
        if isinstance(counts, dict):
            result[key] = {uid: count for uid, count in counts.items()
                           if isinstance(count, (int, float)) and not isinstance(count, bool)}
    for key in ("data", "game", "games", "room", "rooms", "profile"):
        if isinstance(value.get(key), (dict, list)):
            result[key] = shape(value[key])
    return result


def response(flow):
    if flow.request.host not in HOSTS or flow.request.path.split("?")[0] not in READ_PATHS:
        return
    record = {
        "at": int(time.time()), "host": flow.request.host,
        "path": flow.request.path.split("?")[0],
        "status": flow.response.status_code,
        "has_auth": bool(flow.request.headers.get("Authorization")),
    }
    try:
        record["response"] = shape(flow.response.json())
    except (ValueError, TypeError):
        record["response"] = {"type": "non-json"}
    path = private_directory() / "reads.jsonl"
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
    os.fchmod(fd, 0o600)
    with os.fdopen(fd, "w") as output:
        output.write(json.dumps(record, ensure_ascii=True) + "\n")
