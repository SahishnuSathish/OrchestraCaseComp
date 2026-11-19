"""The seam where Conductor meets Orchestra's email system.

Two senders, same interface (`send(Message) -> dict`):

  OutboxMailer  (default)  Writes a real .eml file under dashboards/conductor/state/outbox/ and sends nothing. Everything in the
                           app works end to end, and the employee can open the file to see exactly what would go out.
  SmtpMailer               Hands the message to an SMTP relay. Off unless ORCHESTRA_MAIL_MODE=smtp and the host is
                           set. Credentials come only from the environment, never from code or the browser.

      ORCHESTRA_MAIL_MODE=smtp
      ORCHESTRA_SMTP_HOST=smtp.orchestra.example      ORCHESTRA_SMTP_PORT=587
      ORCHESTRA_SMTP_USER=...  ORCHESTRA_SMTP_PASSWORD=...   (optional, for relays that need a login)
      ORCHESTRA_SMTP_STARTTLS=1                                (default on)
      ORCHESTRA_MAIL_FROM=ap@orchestra.example                 (default: the mailbox the ticket arrived at)

The recipient, subject and body are fixed by the server from the approved review record. Nothing the browser
sends can change who a message goes to.
"""
import os
import re
import smtplib
import time
import uuid
from dataclasses import dataclass, field
from email.message import EmailMessage
from email.utils import formatdate, make_msgid
from pathlib import Path

OUTBOX_DIR = Path(os.environ.get("CONDUCTOR_STATE_DIR") or os.environ.get("AP_DESK_STATE_DIR")
                  or (Path(__file__).resolve().parent / "state")) / "outbox"
_EMAIL = re.compile(r"^[^@\s,;<>]+@[^@\s,;<>]+\.[^@\s,;<>]+$")


class MailError(Exception):
    """Sending failed. The message was not delivered and the review stays approved."""


@dataclass
class Message:
    sender: str
    to: str
    subject: str
    body: str
    ticket_id: int = 0
    headers: dict = field(default_factory=dict)
    attachments: list = field(default_factory=list)  # [(filename, mime, bytes)], rendered from records only

    def validate(self):
        for label, addr in (("sender", self.sender), ("recipient", self.to)):
            if not _EMAIL.match(addr or ""):
                raise MailError(f"The {label} address is not valid: {addr!r}")
        if not (self.body or "").strip():
            raise MailError("The reply is empty.")

    def to_email(self):
        m = EmailMessage()
        m["From"], m["To"] = self.sender, self.to
        m["Subject"] = re.sub(r"[\r\n]+", " ", self.subject or "").strip()[:200]  # no header injection
        m["Date"] = formatdate(localtime=True)
        m["Message-ID"] = make_msgid(idstring=f"apdesk-{self.ticket_id}-{uuid.uuid4().hex[:6]}", domain="ap-desk.local")
        m["X-AP-Desk-Ticket"] = str(self.ticket_id)
        for k, v in self.headers.items():
            m[k] = re.sub(r"[\r\n]+", " ", str(v))
        m.set_content(self.body)
        for filename, mime, data in self.attachments:
            maintype, _, subtype = (mime or "application/octet-stream").partition("/")
            safe = re.sub(r"[^A-Za-z0-9._-]+", "_", filename or "attachment")[:100]
            m.add_attachment(data, maintype=maintype, subtype=subtype or "octet-stream", filename=safe)
        return m


class OutboxMailer:
    mode = "simulated"
    label = "Simulated: saved to the outbox folder, nothing leaves this computer"

    def __init__(self, outbox=None):
        self.outbox = Path(outbox) if outbox else OUTBOX_DIR

    def send(self, msg):
        msg.validate()
        em = msg.to_email()
        self.outbox.mkdir(parents=True, exist_ok=True)
        path = self.outbox / f"ticket-{msg.ticket_id}-{int(time.time())}.eml"
        path.write_bytes(bytes(em))
        return {"id": em["Message-ID"], "mode": self.mode, "path": str(path)}


class SmtpMailer:
    mode = "smtp"

    def __init__(self, host, port=587, user=None, password=None, starttls=True, timeout=20):
        self.host, self.port, self.user, self.password, self.starttls, self.timeout = host, int(port), user, password, starttls, timeout
        self.label = f"Sent through {host}"

    def send(self, msg):
        msg.validate()
        em = msg.to_email()
        try:
            with smtplib.SMTP(self.host, self.port, timeout=self.timeout) as smtp:
                if self.starttls:
                    smtp.starttls()
                if self.user:
                    smtp.login(self.user, self.password or "")
                refused = smtp.send_message(em)
        except (smtplib.SMTPException, OSError) as e:
            raise MailError(f"The mail server did not accept the message ({type(e).__name__}). Nothing was sent.") from e
        if refused:
            raise MailError("The mail server refused the recipient. Nothing was sent.")
        return {"id": em["Message-ID"], "mode": self.mode, "host": self.host}


def get_mailer(env=None):
    env = os.environ if env is None else env
    if (env.get("ORCHESTRA_MAIL_MODE") or "").lower() == "smtp" and env.get("ORCHESTRA_SMTP_HOST"):
        return SmtpMailer(env["ORCHESTRA_SMTP_HOST"], env.get("ORCHESTRA_SMTP_PORT") or 587, env.get("ORCHESTRA_SMTP_USER"),
                          env.get("ORCHESTRA_SMTP_PASSWORD"), (env.get("ORCHESTRA_SMTP_STARTTLS") or "1") != "0")
    return OutboxMailer()


def default_sender(ticket_to, env=None):
    """The From address: ORCHESTRA_MAIL_FROM, else the AP mailbox the ticket was sent to."""
    env = os.environ if env is None else env
    return env.get("ORCHESTRA_MAIL_FROM") or ticket_to or "ap@orchestra-mock.example"
