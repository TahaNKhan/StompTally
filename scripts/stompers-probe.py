#!/usr/bin/env python3
"""Probe only recovered Stompers read routes. No third-party dependencies."""

import argparse
import json
import os
import sys
import urllib.error
import urllib.request


BASE_URL = "https://api.stompers.com"


class NoRedirects(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        # Do not forward a Firebase token to a different URL or host.
        return None


def request(path, body):
    headers = {
        "Content-Type": "application/json",
        "Accept": "application/json",
        "Accept-Language": "en",
    }
    token = os.environ.get("STOMPERS_ID_TOKEN", "")
    if token:
        if "\r" in token or "\n" in token:
            raise ValueError("STOMPERS_ID_TOKEN must be one line")
        headers["Authorization"] = token
    req = urllib.request.Request(
        BASE_URL + path,
        data=json.dumps(body).encode("utf-8"),
        headers=headers,
        method="POST",
    )
    try:
        opener = urllib.request.build_opener(NoRedirects())
        with opener.open(req, timeout=25) as response:
            return json.load(response)
    except urllib.error.HTTPError as error:
        # Avoid printing server bodies, which may echo account/token data.
        raise RuntimeError(f"{path}: HTTP {error.code}") from None
    except urllib.error.URLError:
        raise RuntimeError(f"{path}: network request failed") from None


def summarize(value):
    """Keep token/private profile values out of the output."""
    if isinstance(value, list):
        return {"count": len(value), "items": [summarize(item) for item in value]}
    if not isinstance(value, dict):
        return {"type": type(value).__name__}
    output = {"fields": sorted(value)}
    for key in (
        "uid", "room_uid", "room_uids", "game_uid", "current_game_uid", "starts_at",
        "finishes_at", "time_zone", "state", "game_type",
    ):
        if key in value:
            output[key] = value[key]
    for key in ("game_step_counts", "step_counts", "placements"):
        if key in value:
            output[key] = value[key]
    participants = value.get("participants")
    if isinstance(participants, dict):
        output["participant_uids"] = sorted(participants)
    # Expose only nested shapes; do not dump profile or contact records.
    for key in ("data", "game", "games", "room", "rooms", "profile"):
        if isinstance(value.get(key), (dict, list)):
            output[key] = summarize(value[key])
    return output


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    subcommands = parser.add_subparsers(dest="command", required=True)
    profile = subcommands.add_parser("profile", help="Read your profile")
    identity = profile.add_mutually_exclusive_group(required=True)
    identity.add_argument("--username")
    identity.add_argument("--uid")
    room = subcommands.add_parser("room", help="Read your room")
    room.add_argument("--uid", required=True)
    history = subcommands.add_parser("history", help="Read recent games")
    history.add_argument("--room", required=True)
    history.add_argument("--limit", type=int, default=3)
    game = subcommands.add_parser("game", help="Read one game")
    game.add_argument("--uid", required=True)
    args = parser.parse_args()
    if args.command == "profile":
        if args.username:
            path, body = "/users/getProfileByUsername", {"username": args.username}
        else:
            path, body = "/users/getProfileByUid", {"uid": args.uid}
    elif args.command == "room":
        path, body = "/rooms/getRoom", {"uid": args.uid}
    elif args.command == "history":
        if not 1 <= args.limit <= 20:
            parser.error("--limit must be between 1 and 20")
        path = "/games/getRecentGamesByRoomUid"
        body = {"uid": args.room, "limit": args.limit}
    else:
        path, body = "/games/getGame", {"uid": args.uid}
    try:
        value = request(path, body)
        print(json.dumps(summarize(value), indent=2, ensure_ascii=True))
    except RuntimeError as error:
        print(str(error), file=sys.stderr)
        return 1
    except ValueError:
        # Do not print a token-bearing parsing/validation exception.
        print("Read failed. Check the ID, network, or token.", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
