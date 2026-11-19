"""Send one approved reply through the mail adapter. Shared by "Send now" (server.api_send) and scheduled send.

Recipient, subject and body come from the server's own records, never from a request. Does not import server.py.
"""
import hashlib
import json
import threading

import db
import mailer
import reply_checks

_SEND_LOCK = threading.Lock()  # one send at a time: Send now and the scheduler can never both send the same reply

# Phase 3 seam: called after every successful send as fn(run_id, ticket_id, actor, info). Never raises into a send.
ON_SENT = []
# Phase 3 seam: called after a Conductor: Ahead notice or digest is sent, as fn(run_id, kind, key, item, info).
# `item` is the stored notice/digest dict (it has "to", "text" and, for notices, "vendor_id" and "bills").
ON_NOTICE_SENT = []


def notice_sent(run_id, kind, key, item, info):
    for hook in list(ON_NOTICE_SENT):
        try:
            hook(run_id, kind, key, item, info)
        except Exception as e:
            print(f"[delivery] on_notice_sent hook {getattr(hook, '__name__', hook)!r} failed: {type(e).__name__}: {e}", flush=True)


class DeliveryError(Exception):
    """The reply was not sent. `status` is the HTTP status Send now answers with."""

    def __init__(self, status, message):
        super().__init__(message)
        self.status = status
        self.message = message


def reply_hash(recipient, subject, body):
    """SHA-256 over the three things that go out."""
    return hashlib.sha256(json.dumps([recipient, subject, body], ensure_ascii=True).encode("utf-8")).hexdigest()


def prepare(run_id, ticket_id):
    """Check a reply is sendable now and build the message from the records. Raises DeliveryError otherwise."""
    rec = db.get_ticket(run_id, ticket_id)
    if not rec:
        raise DeliveryError(404, "ticket not found in this run")
    res = rec["bundle"].get("result") or {}
    if res.get("output_type") != "draft_reply" or not res.get("recipient"):
        raise DeliveryError(400, "this ticket has no reply to send")
    if reply_checks.BLOCK_APPROVE_FLAGS & set(res.get("flags") or []):
        raise DeliveryError(409, "flagged tickets cannot be sent from here")
    rv = db.get_review(run_id, ticket_id)
    if rv["state"] == "sent":
        raise DeliveryError(409, "This reply was already sent.")
    if rv["state"] != "approved":
        raise DeliveryError(409, "Approve the reply before sending it.")
    original = res.get("text") or ""
    body_text = rv["edited_text"] if rv.get("edited_text") is not None else original
    default_subject = reply_checks.default_subject(rec["ticket"].get("subject"))
    subject = rv.get("edited_subject") or default_subject
    problems = []
    try:
        if body_text != original:
            problems += reply_checks.edit_problems(original, body_text, res["recipient"])
        if subject != default_subject:
            problems += reply_checks.edit_problems(default_subject, subject, res["recipient"])
    except reply_checks.ChecksUnavailable as e:
        raise DeliveryError(503, str(e))
    if problems:
        raise DeliveryError(422, "This reply can't be sent: it adds " + "; ".join(problems) + ". Reopen it and remove that.")
    import workflow  # Phase 3: sign-off rules apply to Send now and to scheduled send alike
    blocked = workflow.can_send(run_id, ticket_id, reply_hash(res["recipient"], subject, body_text))
    if blocked:
        raise DeliveryError(409, blocked)
    import documents
    msg = mailer.Message(sender=mailer.default_sender(rec["ticket"].get("to")), to=res["recipient"], subject=subject,
                         body=body_text, ticket_id=ticket_id, attachments=list(documents.attachments_for(run_id, ticket_id)))
    return msg


def deliver_reply(run_id, ticket_id, expect_hash=None, actor=None):
    """Send the approved reply and record it as sent. With `expect_hash`, refuse if the reply no longer matches it.
    `actor` is {name, email} for a person's send, None for a scheduled send."""
    with _SEND_LOCK:
        msg = prepare(run_id, ticket_id)
        if expect_hash is not None and reply_hash(msg.to, msg.subject, msg.body) != expect_hash:
            raise DeliveryError(409, "The reply changed after it was scheduled.")
        try:
            info = mailer.get_mailer().send(msg)
        except mailer.MailError as e:
            raise DeliveryError(502, str(e))
        db.save_sent(run_id, ticket_id, info.get("id"), {k: v for k, v in info.items() if k != "path"})
    try:  # a manual send ends any schedule for this reply
        import scheduler
        scheduler.on_sent(run_id, ticket_id)
    except Exception:
        pass
    for hook in list(ON_SENT):
        try:
            hook(run_id, ticket_id, actor, info)
        except Exception as e:  # a hook (write-back, Direct messages) must never undo or fail a send
            print(f"[delivery] on_sent hook {getattr(hook, '__name__', hook)!r} failed: {type(e).__name__}: {e}", flush=True)
    return info
