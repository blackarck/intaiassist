"""Prints which of the permissions we need a SendGrid API key has. Input: the JSON from GET /v3/scopes in $SCOPES_JSON.
Only permission names are handled here; the key itself never reaches this script."""
import json
import os
import sys

NEEDED = [
    ("mail.send", "send e-mail                     (needed later, for notifications)"),
    ("user.webhooks.parse.settings.create", "create the Inbound Parse host   (optional: only for the script; the dashboard needs no key)"),
    ("user.webhooks.parse.settings.read", "read Inbound Parse hosts        (optional, same)"),
    ("user.webhooks.parse.settings.update", "edit the Inbound Parse host     (optional, same)"),
]


def main() -> int:
    try:
        have = set(json.loads(os.environ.get("SCOPES_JSON", "")).get("scopes", []))
    except (ValueError, AttributeError):
        print("Could not read the permission list; continuing.")
        return 0

    print("This key can:")
    for scope, why in NEEDED:
        ok = scope in have
        print(f"  {'YES' if ok else 'NO '}  {scope:38s} {why}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
