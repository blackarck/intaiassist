"""Prints which of the permissions we need a SendGrid API key has. Input: the JSON from GET /v3/scopes in $SCOPES_JSON.
Only permission names are handled here; the key itself never reaches this script."""
import json
import os
import sys

NEEDED = [
    ("user.webhooks.parse.settings.create", "create the Inbound Parse host   (needed now)"),
    ("user.webhooks.parse.settings.read", "read Inbound Parse hosts        (needed now)"),
    ("user.webhooks.parse.settings.update", "edit the Inbound Parse host     (useful)"),
    ("mail.send", "send e-mail                     (needed later)"),
]


def main() -> int:
    try:
        have = set(json.loads(os.environ.get("SCOPES_JSON", "")).get("scopes", []))
    except (ValueError, AttributeError):
        print("Could not read the permission list; continuing.")
        return 0

    print("This key can:")
    missing_now = False
    for scope, why in NEEDED:
        ok = scope in have
        print(f"  {'YES' if ok else 'NO '}  {scope:38s} {why}")
        if not ok and "needed now" in why:
            missing_now = True
    if missing_now:
        print("\nA permission needed now shows NO. If you ticked Inbound Parse when creating the key, SendGrid's response format may")
        print("have changed and the key could still be fine; otherwise create the key again with the Inbound Parse permissions ticked.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
