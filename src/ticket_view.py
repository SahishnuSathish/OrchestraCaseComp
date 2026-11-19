"""Normalize a Zendesk-style ticket into the fields the pipeline needs.

Ticket text is built from end-user comments only. Agent replies (the
"Thanks for reaching out..." holding replies) are dropped.
"""
from dataclasses import dataclass, field


@dataclass
class TicketView:
    id: int
    subject: str
    body: str                      # end-user comments joined, oldest first
    attachments: list              # file names from end-user comments
    sender_email: str
    sender_name: str
    received_at: str
    cc_user_ids: list
    linked_ticket_ids: list
    requester_id: int = None
    comment_count: int = 0
    raw: dict = field(default_factory=dict, repr=False)

    @property
    def first_name(self):
        n = (self.sender_name or "").strip()
        if not n or "@" in n or any(w in n.lower() for w in ("billing", "notification", "team", "desk", "system")):
            return None
        return n.split()[0].capitalize()

    def all_text(self):
        """Subject, body and attachment names: everything untrusted we may read."""
        return "\n".join([self.subject or "", self.body or "", " ".join(self.attachments)])


def build_view(ticket, user_lookup):
    """user_lookup(id) -> user dict or None. Only used for comment author roles."""
    src = ((ticket.get("via") or {}).get("source") or {}).get("from") or {}
    sender_email = (src.get("address") or "").strip().lower()
    sender_name = src.get("name") or ""
    requester_id = ticket.get("requester_id")
    if not sender_email and requester_id is not None:
        u = user_lookup(requester_id)
        if u:
            sender_email = (u.get("email") or "").lower()
            sender_name = sender_name or u.get("name") or ""

    bodies, files = [], []
    comments = ticket.get("comments") or []
    if not comments and ticket.get("description"):
        comments = [{"author_id": requester_id, "body": ticket["description"], "attachments": []}]
    roles = {}
    for c in comments:
        aid = c.get("author_id")
        if aid not in roles:
            u = user_lookup(aid) if aid is not None else None
            roles[aid] = (u or {}).get("role")
        role = roles[aid]
        # Keep anything not positively known to be staff. Unknown authors are
        # untrusted text and must still pass through the fraud screen.
        if role == "agent":
            continue
        bodies.append(c.get("body") or "")
        files += [a.get("file_name") or "" for a in (c.get("attachments") or [])]

    linked = []
    for cf in ticket.get("custom_fields") or []:
        if cf.get("id") == "linked_ticket_ids" and isinstance(cf.get("value"), list):
            linked = [int(x) for x in cf["value"]]

    return TicketView(
        id=int(ticket["id"]),
        subject=ticket.get("subject") or "",
        body="\n\n".join(bodies),
        attachments=[f for f in files if f],
        sender_email=sender_email,
        sender_name=sender_name,
        received_at=ticket.get("created_at") or "",
        cc_user_ids=list(ticket.get("email_cc_ids") or []),
        linked_ticket_ids=linked,
        requester_id=requester_id,
        comment_count=len(comments),
        raw=ticket,
    )
