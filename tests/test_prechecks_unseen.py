"""Regressions from the Nov 19 unseen tickets: an out-of-office phrase in a message that still asks for something, and a
thank-you written above a forwarded AP reply."""
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

import prechecks  # noqa: E402
from cues import scan  # noqa: E402


def view(body, sender="someone@example.example"):
    return SimpleNamespace(body=body, sender_email=sender, all_text=lambda: body)


class OutOfOfficeTests(unittest.TestCase):
    def test_a_person_out_of_the_office_who_asks_is_not_an_auto_reply(self):
        body = ("Hi team, Ben here, I work with Foxglove Talent. Could you send me the payment details you have for this "
                "invoice? I'm on my personal email at the moment because I'm out of the office.")
        tag, _ = prechecks.tier2(view(body, "ben4@freemail.example"), scan(body), "unknown")
        self.assertNotEqual(tag, "machine_notice")

    def test_a_real_out_of_office_reply_is_still_a_machine_notice(self):
        body = "I am currently out of the office with limited access to email. I will reply when I return on Monday."
        tag, _ = prechecks.tier2(view(body, "jane@vendor.example"), scan(body), "vendor_contact")
        self.assertEqual(tag, "machine_notice")

    def test_codes_and_webinars_stay_machine_notices_even_with_a_question(self):
        body = "Your one-time code is 123456. Did you request this?"
        tag, _ = prechecks.tier2(view(body), scan(body), "unknown")
        self.assertEqual(tag, "machine_notice")


class ForwardedThankYouTests(unittest.TestCase):
    def test_thanks_above_our_forwarded_reply_asks_for_nothing(self):
        body = ("Thanks for confirming, much appreciated!\n\nAna\n\n---------- Forwarded message ----------\n"
                "From: Accounts Payable\nTo: Ana Northcott\nSubject: Re: Thistledown Staffing payment\n\n"
                "Hi Ana, confirming as you asked. Let us know if you need anything else.\n\nAP Team")
        tag, _ = prechecks.tier2(view(body, "ana@thistledown.example"), scan(body), "vendor_contact")
        self.assertEqual(tag, "no_request")

    def test_a_question_above_a_forward_is_still_a_request(self):
        body = ("Thanks! Can you check whether this one has been paid?\n\n---------- Forwarded message ----------\n"
                "From: Vendor\nSubject: Invoice 123\n\nHello, please let us know the status.")
        tag, _ = prechecks.tier2(view(body, "maya@orchestra.example"), scan(body), "employee")
        self.assertIsNone(tag)

    def test_own_text_stops_at_the_quote(self):
        self.assertEqual(prechecks.own_text("Thanks\n\nOn Mon, Nov 9, 2026 AP wrote:\n> Paid."), "Thanks")
        self.assertEqual(prechecks.own_text("No quote here."), "No quote here.")


if __name__ == "__main__":
    unittest.main()
