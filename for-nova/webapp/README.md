# AP Desk

AP Desk is a local web app that runs the ticket pipeline over a dataset folder, then lets a person review, edit, approve and send the drafted replies. It runs only on this computer: the server listens on 127.0.0.1 and nothing is sent to a requester unless a person approves it and clicks Send.

## Start

Install the dependencies:

```
pip install fastapi uvicorn pydantic
```

Run the server from the `for-nova/` folder:

```
python webapp/server.py
```

The app is then at http://127.0.0.1:8790/ (the default). Options:

- `--port N` sets the port (default `8790`).
- `--open` also opens the app in the default browser.

## Pages

| Route | What it is for |
|---|---|
| `#/runs` | Runs home: every run, import of saved results, and the "New run" button |
| `#/runs/new` | New run: choose the dataset, reader options, and start the run |
| `#/runs/:runId` | Run overview: status and progress, outcomes, review progress, primary actions |
| `#/runs/:runId/tickets` | Ticket list with search, filters and sort; `/tickets/:ticketId` shows one ticket |
| `#/runs/:runId/review` | Review queue of drafted replies and notes; `/review/:ticketId` shows one draft |
| `#/settings` | Local model (server address, model, time limit) and mail delivery mode |
| anything else | "Page not found", with a link back to Runs |

## Local model

The local model is an optional second reader. In a run that has the model option turned on, it reads the tickets the built-in regex reader is unsure about (a gate skips the model where regex is already confident, and earlier answers are cached), and it can only add caution to what the regex reader found. It also writes and rewrites the brief shown on a ticket, and every brief is checked against the records before it is shown. It talks to an Ollama server.

Settings are resolved per key in this order:

1. The values saved on the Settings page (stored in the app database).
2. The environment variables `OLLAMA_URL` and `OLLAMA_MODEL`.
3. Built-in defaults: server `http://127.0.0.1:11434`, model `qwen3.5:9b`, time limit 120 seconds (the time limit is set only on the Settings page, 5 to 600 seconds).

Local only: the server address must be `http://` or `https://` with a host that is `localhost`, `127.0.0.1`, `::1`, or a name ending in `.local` or `.internal`. Any other address is refused ("Only a model server on this computer or your local network name can be used"). There is no cloud fallback. If the model is unavailable, runs use the regex reader only and record a warning.

Status states shown on the Settings page and in the model chip:

- `ready`: the server answers and the selected model is installed.
- `unreachable`: nothing answers at the address, or the server did not answer in time.
- `no_models`: the server answers but has no models installed.
- `model_missing`: the server answers but the selected model is not installed.
- `not_local`: the configured address is not a local host, so it is never contacted.

To set up Ollama:

```
ollama serve
ollama pull qwen3.5:9b
```

Replace `qwen3.5:9b` with the model you selected if it differs. The Settings page has a "Test the reader" console: its output streams, and Stop closes the connection so Ollama stops generating. Pipeline runs and brief rewrites wait for the complete answer.

## Email delivery

Two modes. The mode is chosen by the environment when the server starts and cannot be changed from the UI.

- `simulated` (default): each approved reply is written as a `.eml` file in the outbox folder (`webapp/state/outbox/` unless `AP_DESK_STATE_DIR` is set). Nothing leaves the computer.
- `smtp`: the reply is handed to an SMTP relay. This mode is used only when `ORCHESTRA_MAIL_MODE=smtp` and `ORCHESTRA_SMTP_HOST` are both set.

Environment variables: `ORCHESTRA_MAIL_MODE` (`smtp` to enable SMTP), `ORCHESTRA_SMTP_HOST`, `ORCHESTRA_SMTP_PORT` (default `587`), `ORCHESTRA_SMTP_USER` and `ORCHESTRA_SMTP_PASSWORD` (optional, for relays that need a login), `ORCHESTRA_SMTP_STARTTLS` (on by default; `0` turns it off), and `ORCHESTRA_MAIL_FROM` (default: the mailbox the ticket was sent to).

The recipient, subject and body of a sent message always come from the server's own records of the approved review. The browser cannot change them.

## Where state lives

The SQLite database is `app.db` and the outbox is `outbox/`, both under `webapp/state/` by default. Set `AP_DESK_STATE_DIR` to a folder to move both. The folder is created if it does not exist. Each launch of the server uses the folder set at that time.

Deleting a run removes its row, tickets, briefs and review decisions in one transaction. It does not touch the dataset folder or `.eml` files already in the outbox. A run in progress cannot be deleted (HTTP 409).

## Security model

- The server binds to 127.0.0.1 only.
- Requests are refused unless the Host header is `localhost`, `127.0.0.1` or `::1`.
- Write requests (any method except GET and HEAD) are refused when the Origin header does not match the Host.
- Every `/api` call needs a per-launch token (header `x-ap-token`, or a `token` query parameter), injected into the page at start and new on each restart.
- Responses carry a Content-Security-Policy that limits scripts, images and connections to the same origin (styles may be inline) and blocks framing. They also set `Cache-Control: no-store`, `X-Content-Type-Options: nosniff` and `Referrer-Policy: no-referrer`.
- The recipient, subject and body of a sent mail come from the server's records, never from the request.
- Tickets flagged `fraud` or `injection` cannot be approved or sent from the app; a person must handle them.

## API

All paths are under `/api`, and every call needs the `x-ap-token` header. `GET /` serves the page itself.

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/health` | Liveness check |
| GET | `/api/model/status` | Local model status (`?force=true` skips the 5 second cache) |
| GET | `/api/settings` | Current model settings, their sources, and mail mode |
| PUT | `/api/settings/model` | Save model URL, model name or time limit (`null` clears a value) |
| POST | `/api/model/test` | Stream one reading from the local model (server-sent events) |
| GET | `/api/fs/list` | List folders on this computer for the dataset picker |
| POST | `/api/dataset/validate` | Check that a folder is a usable dataset |
| GET | `/api/runs` | List runs, with counts and the active run |
| POST | `/api/runs` | Start a run on a dataset |
| POST | `/api/runs/import` | Import saved results as a run |
| GET | `/api/runs/{run_id}` | One run |
| DELETE | `/api/runs/{run_id}` | Delete a run and its stored data |
| POST | `/api/runs/{run_id}/cancel` | Cancel a run in progress |
| GET | `/api/runs/{run_id}/events` | Live progress of a run (server-sent events) |
| GET | `/api/runs/{run_id}/tickets` | Ticket rows of a run, with review state |
| GET | `/api/runs/{run_id}/tickets/{ticket_id}` | One ticket: record, draft, brief, review and mail info |
| POST | `/api/runs/{run_id}/tickets/{ticket_id}/brief` | Queue a model rewrite of one brief |
| POST | `/api/runs/{run_id}/briefs/upgrade` | Queue model rewrites of all briefs in a run |
| PUT | `/api/runs/{run_id}/review/{ticket_id}` | Set a review state (pending, approved, returned, acknowledged, closed) with optional text and note |
| POST | `/api/runs/{run_id}/review/bulk` | Set one review state on many tickets |
| PUT | `/api/runs/{run_id}/review/{ticket_id}/draft` | Autosave the edited reply and subject (does not change the state) |
| GET | `/api/mail/status` | Current mail mode and sender |
| POST | `/api/runs/{run_id}/tickets/{ticket_id}/send` | Send an approved reply through the mail adapter |
| GET | `/api/runs/{run_id}/export` | Download results as a score.py-style JSON file (`?scope=signed_off` or `all`) |

## Tests

From `for-nova/`:

```
python -m unittest discover -s tests -p "test_*.py"
```

`tests/fake_ollama.py` is a test stand-in for Ollama that performs no inference; its replies are canned. For manual UI checks, run it by hand:

```
python tests/fake_ollama.py --port 11434 --models qwen3.5:9b,llama3.2:3b --token-delay 0.03 --first-token-delay 0
```

Add `--fail http500` or `--fail garbage` to exercise failure states. Point the app at it with `OLLAMA_URL=http://127.0.0.1:11434` (use another port if a real Ollama runs on 11434).
