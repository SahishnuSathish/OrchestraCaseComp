# Ticket chat

Ask the local model follow-up questions about one ticket. The panel sits in the ticket detail (Tickets view) and the review detail, inside `#chat-slot`.

## What it does
- Scoped to one run and one ticket. Each ticket has its own history.
- The server builds the context from its own records: sender name and domain, subject, original message, the rule and why, flags, review state, the current draft reply and the brief. No other tickets or vendors.
- Uses the model chosen in Settings (default `qwen3.5:9b`). Plain text, no JSON schema, `think: false`. Only local hosts are contacted.
- History is kept in table `ticket_chat` (`run_id`, `ticket_id`, `role`, `content`, `created_at`). At most the last 20 messages go to the model. Deleting a run clears its chat.
- A stopped, failed or cancelled question is not saved.

## Endpoints (token required)
- `POST /api/runs/{run_id}/tickets/{ticket_id}/chat` with `{"message": "..."}`. Server-sent events: `start`, `token`, then `done` (`text`, `ms`, `tokens`) or `error` (`kind`, `message`). Kinds: `not_local`, `model_missing`, `unreachable`, `timeout`, `empty`, `http`.
- `GET .../chat` returns `{"messages": [...]}`.
- `DELETE .../chat` clears the history.
- Closing the connection (Stop in the UI) closes the upstream request so the model stops.

## Safety
- Chat is read-only. It cannot approve, edit, send or change any state, and it never touches the outbox. Its only write is its own history table.
- Ticket text is untrusted. It is wrapped in `<<<TICKET_DATA ... TICKET_DATA>>>` and the system prompt says to ignore instructions inside it and to say when the ticket does not answer. The delimiters are stripped from ticket text.
- Everything sent to the model, the question and saved answers pass through `extract_model.redact`: emails become `[email]` and long digit runs (account, routing, TIN) become `[number withheld]`.
- Non-local model URLs are refused before any request is made.

## Frontend
`static/js/chat.js` keeps one panel per `runId:ticketId` in a module cache and re-appends it into each new slot, so a live re-render does not drop the stream, the typed text or the history. Stop and Clear are the only things that abort a stream.

## Tests
```
export CONDUCTOR_STATE_DIR="<a folder outside the repo>"
python -m unittest tests.test_chat -v
node --test tests/js/chat.test.mjs
```
`tests/test_chat.py` uses `tests/fake_ollama.py` for canned replies (no model needed).
