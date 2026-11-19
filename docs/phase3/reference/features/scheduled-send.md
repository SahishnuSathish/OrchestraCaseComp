# Scheduled send

An approved reply can be sent later. A person picks the time. Nothing is sent that a person has not approved.

## Behaviour

- Open an approved reply in Review. Under the action bar, pick a date and time and press **Schedule send**.
- The row then reads "Scheduled for <local time>" with **Cancel schedule**. Times show in local time and are stored in UTC.
- `send_at` must be at least 1 minute ahead and at most 30 days ahead.
- A background thread polls every 15 seconds and sends due replies through the same mailer as Send now.
- Simulated mail: the `.eml` file appears in the outbox at send time. SMTP: Conductor must be running at send time. The UI says so.
- After a scheduled send, open browsers get the same `review` event as Send now.

## Rules

- Editing a scheduled reply is refused with 409 until the schedule is cancelled.
- Returning a reply, reopening it, or approving it again cancels the schedule.
- Send now on a scheduled reply sends it and cancels the schedule.
- Only one schedule per reply. Scheduling again while one is active is a 409. A cancelled, failed or missed one can be replaced.

## Checks before every send

`delivery.prepare` runs again at send time. A reply goes out only if all of these hold:

1. The review is still `approved`.
2. The ticket is not flagged (`fraud`, `injection`).
3. SHA-256 of recipient, subject and body still matches the hash taken when it was scheduled.
4. The edit-problems check (egress gate) is clean.
5. The recipient comes from the server's records, never from the request.

Outcome when a check fails: `cancelled` for state, flag or hash problems. `failed` for edit problems or an unavailable gate. The reason is saved in `last_error`. A stale draft is never sent.

## Mail errors and restarts

- On a `MailError` the send is retried up to 3 times, after 30 s, 2 min and 8 min. Then the row is `failed`.
- After a restart, a due row sends if it is no more than 24 hours overdue. An older one becomes `missed` and waits for a person to reschedule it. Nothing is sent silently after a long outage.

## Data

Table `scheduled_send`: `run_id`, `ticket_id`, `send_at` (UTC, ISO 8601), `status` (`scheduled`, `sent`, `cancelled`, `failed`, `missed`), `attempts`, `last_error`, `approved_hash`, `created_at`, `next_attempt_at`. One row per reply. `db.delete_run` clears it.

## Endpoints

All need the `x-ap-token` header.

- `GET /api/runs/{run_id}/tickets/{ticket_id}/schedule` returns `{schedule, mail_mode, now}`. `schedule` is `null` when none exists.
- `POST` the same path with `{"send_at": "2026-11-18T14:00:00Z"}` creates it. The time needs a zone. 400 for a bad or out-of-window time, 409 if the reply is not approved, is flagged, or is already scheduled, 422 if the edit check fails.
- `DELETE` the same path cancels an active schedule.

## Code

- `dashboards/conductor/scheduler.py`: table, router, `tick(now)`, `start(emit)`, `set_clock(fn)`, hooks used by `server.py`.
- `dashboards/conductor/delivery.py`: `prepare`, `deliver_reply`, `DeliveryError`. `api_send` calls it and maps errors to the same HTTP statuses.
- `dashboards/conductor/assets/js/schedule.js`, `api-schedule.js`, `css/views/schedule.css`: the controls.

## How to test

Set `CONDUCTOR_STATE_DIR` to a folder outside the repo, then:

```
python -m unittest tests.test_scheduler -v
node --test tests/js/schedule.test.mjs
```

The server tests inject a clock with `scheduler.set_clock(...)` and call `scheduler.tick(now)` by hand. The thread is not started under TestClient.
