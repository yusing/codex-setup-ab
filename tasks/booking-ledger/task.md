# Build Booking Ledger

Create a complete local command-line application for a small equipment desk to
reserve quantities of shared equipment. Start from this empty project. Use Python
3.12 or later, its standard library, and SQLite, with no third-party dependencies.
The public entry point is `python3 -m booking_ledger`. Choose the command names,
flags, internal design, and JSON output layout, and document them.

## Product requirements

1. **Persistent resources and bookings.** Let the operator select a database path,
   initialize a new database, add resources, create bookings, and list resources
   and bookings. A resource has a unique nonempty string ID and a positive integer
   capacity. A booking has a globally unique nonempty string ID, resource ID,
   positive integer quantity, start, end, and status (`active` or `cancelled`).
   Initialization is repeatable without erasing data. Separate database paths are
   independent. IDs are case-sensitive and support spaces and Unicode. Capacities
   are immutable after resource creation; booking IDs remain reserved after cancellation.
2. **Time and capacity correctness.** Accept timestamps only in the UTC format
   `YYYY-MM-DDTHH:MM:SSZ`, with valid calendar dates and start strictly before end.
   Every interval is half-open: `[start, end)`. Active booking quantities summed
   at any instant must not exceed the resource's capacity. Adjacent bookings do
   not overlap. Cancelled bookings consume no capacity. Reject missing resources,
   duplicate IDs, invalid timestamps, zero/negative/noninteger quantities or
   capacities, and capacity conflicts without changing prior data.
3. **Cancellation and atomic rescheduling.** Cancelling an active booking releases
   capacity; cancelling it again succeeds without further changes. A missing ID
   is an error. Rescheduling changes an active booking's start, end, and quantity
   together, preserving its ID and resource. Check capacity without counting its
   old interval. A rejected reschedule retains all old values. Rescheduling a
   cancelled booking is an error. Successful mutations stay within capacity even
   when independent CLI processes write to the same database concurrently.
4. **Availability.** For a resource and query interval, return the maximum constant
   additional quantity that could be booked for the *entire* interval, without
   changing data. This is capacity minus the peak existing active quantity within
   that interval, not capacity minus the sum of all bookings that touch it.
5. **Atomic JSON import and dry run.** Import a UTF-8 JSON file with this shape:

   ```json
   {
     "resources": [{"id": "Camera kit", "capacity": 3}],
     "bookings": [{"id": "B-1", "resource_id": "Camera kit", "quantity": 2,
                   "start": "2026-11-02T09:00:00Z", "end": "2026-11-02T11:00:00Z"}]
   }
   ```

   Both arrays are required and can be empty; each item requires exactly the shown
   fields. Imported bookings are active. Reject extra fields, wrong JSON types
   (including booleans as integers), and duplicate object keys. Bookings can refer
   to existing resources or resources in the same file. Validate against existing
   data and the whole batch, using the same rules as individual operations.
   Either commit every item or commit none. Dry run performs the same validation,
   reports success or rejection, and leaves persistent records unchanged. A bad
   JSON file, conflict late in a batch, or rejected dry run must preserve prior data.
6. **Utilization report.** For an explicit query interval, report every resource,
   including unused resources. Give capacity, peak active quantity within the
   interval, and booked unit-seconds: sum each active booking's quantity times
   the seconds of its intersection with the query. Cancelled bookings and time
   outside the query contribute zero. Do not use the machine's current time.
7. **Usable CLI.** Provide discoverable help, human-readable output, and a JSON
   output option for resource/booking lists, availability, reports, and successful
   mutations/imports. Booking listings include status and can filter by resource
   and status. Lists and reports have deterministic ID order. Success exits zero;
   rejected operations exit nonzero with a useful stderr error and no traceback
   for expected input errors. JSON-mode success writes one valid JSON value to
   stdout, without progress text. Read-only commands must reject an uninitialized
   database without silently initializing it. Support database/file paths with spaces.
8. **Complete delivery.** Include a README with setup, the public interface,
   behavior and error rules, a runnable create/book/reschedule/cancel/report/import
   example, and the test command. Provide tests runnable with
   `python3 -m unittest discover -s tests -v`. Exercise actual CLI/persistence
   behavior as well as the interval, rollback, import, dry-run, and report rules.
   Deliver the working project and identify any unfinished requirement accurately.

## Acceptance examples

- A resource of capacity 3 has two quantity-2 bookings, 09:00–10:00 and
  10:00–11:00 on the same UTC day. Both succeed. Availability for 09:00–11:00
  is 1. Adding quantity 2 for 09:30–10:30 fails even though each existing
  booking is separately below capacity. Adding quantity 1 succeeds.
- For those first two bookings alone, the report for 09:30–10:30 has peak 2
  and 7200 booked unit-seconds. A booking starting exactly at 10:30 contributes
  nothing. An unused resource has peak 0 and booked unit-seconds 0.
- A resource of capacity 3 has a quantity-2 booking from 09:00–10:00 and a
  quantity-1 booking from 09:30–10:30. Moving the first booking to 09:15–10:15
  with quantity 2 succeeds. Increasing it to quantity 3 fails and preserves
  its previous interval and quantity. Cancelling the second booking then permits it.
- An import containing a valid new resource followed by conflicting bookings
  leaves neither the new resource nor any new bookings behind. A valid dry run
  reports success but inserts nothing; a real import of that same file succeeds.

## Scope

This is a single-machine, local CLI. No web UI, server, authentication, recurring
bookings, resource edits/deletion, timezone conversion, external services, or
background jobs are required. Deliver these fixed requirements without replacing
them with a smaller demo or adding adjacent product features.
