"""Keyword families used by the pre-checks and the regex extractor.

These are broad families of phrasing, not sentences copied from tickets. Each
family is a list of regexes searched case-insensitively over the untrusted
ticket text. `scan()` returns the matched snippets per family so the bundle can
show *why* a cue fired.
"""
import re

_W = r"[^.\n?!]{0,40}"  # up to 40 chars within the same sentence

FAMILIES = {
    # ---- fraud -----------------------------------------------------------
    "bank_change": [
        r"\b(new|updated|changed|different|revised|replacement)\s+(bank(ing)?(\s+(details|information|info|account|instructions))?|account\s+(details|number|information|info)|remit(tance)?(\s+to)?\s+(details|information|address|instructions|account)|payment\s+(details|instructions|information|account))\b",
        r"\b(chang(e|ed|es|ing)|switch(ed|ing)?|mov(e|ed|ing)|updat(e|ed|ing)|replac(e|ed|ing))\b" + _W + r"\b(bank|banks|banking|bank account|bank details|account details|remit(tance)?( details| address| information)?|payment (details|instructions))\b",
        r"\bpayments?\s+(should|must|will|need to|needs to)\s+(now\s+)?(be\s+)?(directed|sent|made|wired|remitted|paid|routed|deposited)\s+(to|into)\b",
        r"\b(please|kindly)\s+(use|update|note|record)\s+(the|our)\s+new\s+(bank|banking|account|details|remit|payment details)\b",
        r"\b(old|previous|former|existing)\s+(bank\s+)?account\b" + _W + r"\b(not valid|closed|no longer|inactive|invalid)\b",
        r"\b(routing|aba|iban|swift|bic|sort code)\b[^\n]{0,25}\d{4,}",
        r"\baccount\s*(number|no\.?|#)\s*[:#]?\s*\d{4,}",
    ],
    "login_language": [
        r"\b(sign|log)[\s-]?(in|on)\b", r"\blogin\b", r"\bclick (here|the link|below)\b",
        r"\bverify your (account|identity|details)\b", r"\b(enter|confirm) your (password|credentials)\b",
    ],
    # ---- automated / not for us -----------------------------------------
    "no_reply_text": [
        r"\b(mailbox|inbox|address|email account) is not monitored\b",
        r"\bnot monitored\b",
        r"\breplies to this (address|email|message|mailbox) (will not|won't) be (read|seen|answered)\b",
        r"\b(please )?do not reply to this (email|message|address)\b",
    ],
    "machine_notice": [
        r"\bone[\s-]time (pass)?code\b", r"\b(verification|security|sign[\s-]?in|login|authentication|access) code\b",
        r"\bpasscode\b", r"\bwebinar\b", r"\byou'?re invited\b", r"\b(reserve|save) your (spot|seat)\b", r"\bregister now\b",
        r"\bunsubscribe\b", r"\bnewsletter\b", r"\bout of (the )?office\b", r"\bauto(matic|mated)?[\s-]?reply\b",
        r"\bi am (currently )?(away|on leave|out)\b", r"\blimited access to (my )?e-?mail\b",
        r"\be-?signature\b", r"\bdocusign\b", r"\b(envelope|document) (has been )?(signed|completed|sent for signature)\b",
        r"\bplease (review and )?sign\b", r"\bthis is an automated (message|notification|email)\b",
    ],
    "hr_or_payroll": [
        r"\bpay ?stubs?\b", r"\bpay ?slips?\b", r"\bmy (pay ?check|salary|wages?|payroll|bonus|benefits|401k|pto|direct deposit)\b",
        r"\bw-?2\b", r"\bpayroll (question|issue|error|problem|team|department)\b", r"\b(vacation|sick) (days|leave|balance)\b",
    ],
    "receivable_from_client": [
        r"\binvoices?\s+(that\s+)?you(\s+guys)?\s+(issued|sent|raised|billed)(\s+to)?\s+us\b",
        r"\b(we|we've|we have|we just|our (finance|accounts?|ap) (person|team|department)( has| have)?)\s+(just\s+)?(sent|made|paid|remitted|wired|initiated|processed|scheduled)\s+(our|the|your|a|this)?\s*(payment|remittance)\b",
        r"\bour payment (is on (its|the) way|has been sent|went out|was sent)\b",
        r"\bremittance advice\b", r"\b(paid|settled|paying) your invoice\b",
    ],
    "gratitude": [
        r"\bthanks?( you)?( so much| very much| a lot| again)?\b", r"\bmuch appreciated\b", r"\bappreciate (it|this|that)\b",
        r"\bgrateful\b", r"\bcheers\b",
    ],
    "request": [
        r"\?", r"\b(can|could|would|will) (you|someone|somebody)\b", r"\bplease\s+(let|confirm|advise|send|tell|check|update|provide|look|share|resend|pay|process|reply|get back)\b",
        r"\blet (me|us) know\b", r"\bstatus\b", r"\bwhen (will|is|can|should|does|do)\b", r"\b(has|have) (it|this|they|these) been\b",
        r"\b(need|want|like) to (know|find out|confirm|check)\b", r"\bwondering\b", r"\bchecking (in|on)\b", r"\bfollowing up\b",
        r"\bfollow[\s-]?up\b", r"\bany update\b", r"\basking (about|for|me)\b", r"\bwhere (is|are|does)\b", r"\bpls\b",
    ],
    # ---- intents with their own rule ------------------------------------
    "not_received": [
        r"\b(haven'?t|have not|hasn'?t|has not|didn'?t|did not|never|not yet|still not|still haven'?t)\s+(been\s+)?(received|receive|arrived|landed|come in|came in|showed up|shown up|hit|cleared|reached)\b(?!\s+(a|any|your)?\s*(reply|response|answer|word|confirmation|acknowledg))",
        r"\bnever (showed|turned) up\b", r"\bnothing (has )?(hit|arrived|come in|came in|landed|shown up|showed up)\b",
        r"\b(funds|money|payment|deposit)\s+(have|has)\s+not\s+(arrived|landed|come|shown|reached|cleared)\b",
        r"\b(can'?t|cannot|couldn'?t|could not|don'?t|do not)\s+(find|see)\s+(anything|it|the (payment|funds|money|deposit))\b" + _W + r"\b(come in|bank|account|arriv)",
        r"\bwhere(\s+is|'s)\s+(the|my|our)\s+(money|payment|funds)\b", r"\bwhere the money went\b",
        r"\bnot (been )?received\b(?!\s+(a|any|your)?\s*(reply|response|answer|word|confirmation))",
        r"\b(no sign|no trace) of (the |our |my )?(payment|funds|money|deposit)\b",
    ],
    "expedite": [
        r"\bpay\b[^.\n?!]{0,30}\b(early|earlier|sooner|ahead of|faster|quicker|before the)\b",
        r"\b(early|earlier|expedited?|rush(ed)?|urgent|advance|off[\s-]cycle|same[\s-]day)\s+payment\b",
        r"\bexpedit(e|ed|ing)\b", r"\b(ahead of|outside|before|separate from)\s+(of\s+)?(the|your)\s+(normal|regular|usual|next|scheduled)?\s*(payment\s+)?(run|cycle|schedule|batch)\b",
        r"\boff[\s-]cycle\b", r"\bspecial (payment|run)\b",
    ],
    "late_fee": [
        r"\blate[\s-]?(payment\s+)?(fee|charge|penalt(y|ies))s?\b", r"\binterest\s+(charge|on (the )?(overdue|late|outstanding))\b",
        r"\b\d+(\.\d+)?\s?%\s+(late|interest|penalty|fee)\b", r"\bpenalty\b",
    ],
    "threat": [
        r"\b(to|into|with|for)\s+collections?\b", r"\bcollections?\s+(agency|process|action|firm|department|team)\b", r"\bdebt collect", r"\blegal (action|proceedings|counsel|team)\b",
        r"\b(our|a|my) (lawyer|attorney|solicitor)s?\b", r"\bsmall claims\b", r"\b(take|taking) (you|this|it) to court\b",
        r"\bsu(e|ing)\s+(you|orchestra)\b", r"\bsuspend(ing|ed)?\s+(all\s+)?(service|services|work|deliveries|delivery|the project|your account|production|access)\b",
        r"\b(stop|halt|pause|cease)(ped|ping|ed|ing)?\s+(all\s+)?(work|service|services|deliveries|scheduling|production)\b",
        r"\b(put|place|placing)\s+(your|the)\s+account\s+on\s+(credit\s+)?hold\b", r"\bcredit hold\b",
        r"\bfinal (notice|demand|warning)\b", r"\bformal complaint\b", r"\breport (you|this) to\b",
    ],
}

_COMPILED = {k: [re.compile(p, re.I) for p in v] for k, v in FAMILIES.items()}

URL_RE = re.compile(r"\bhttps?://[^\s<>\"')]+|\bwww\.[^\s<>\"')]+", re.I)


def scan(text):
    """Return {family: [matched snippet, ...]} for families that matched."""
    out = {}
    for fam, pats in _COMPILED.items():
        hits = []
        for p in pats:
            for m in p.finditer(text or ""):
                hits.append(m.group(0).strip())
        if hits:
            out[fam] = hits[:5]
    return out


def urls(text):
    return URL_RE.findall(text or "")
