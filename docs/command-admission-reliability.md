# First-apply bulb reliability — 2026-11-09

Robert reported applying Golden Focus twice before the Office Rod Lamp and Office
Bear Lamp responded. Persisted operations identify the first apply at
2026-11-10 00:14:19 UTC and the second at 00:24:46 UTC (the previous evening in
America/Chicago). The first also failed on Office Lamp. These three Feit targets
failed without an applied field. The second apply observed all three requested
states. Five bedroom Feits remained unreachable on both applies; the current
evidence does not establish their physical power state.

The first Rod/Bear operations exhausted three attempts in roughly 16.46 seconds.
Each attempt took about five seconds. The runtime used that same five-second
window for waiting on the adapter's shared concurrency budget and talking to the
bulb. Feit has two concurrent slots; queued requests could reach the driver with
almost none of their response window left. Expired pre-write polling then marked
the target offline and prevented its assignment. The previous retry change did
not correct this scheduling defect.

Three runtime regression cases fail on the old implementation: preserving an
I/O window after waiting for another device, ordering a queued control ahead of
background probing, and distinguishing a queue expiry from a connectivity
failure. The correction is:

- Queue admission and actual adapter I/O have separate bounded deadlines. The
  adapter receives a complete response window after obtaining its slot.
- Waiting controls take priority over eligible background reads sharing that
  budget. Equal-priority requests are FIFO. Cooling devices and unrelated budgets
  cannot block eligible requests. Already-running I/O is not preempted.
- Absolute assignments contact the adapter directly rather than requiring an
  additional successful poll first. The verified write provides reachability and
  state evidence. Capability checks, reservations and per-device ordering remain.
- Poll queue expiry does not claim a device is offline. Actual OFFLINE responses
  still do. Verification reads take control priority and follow any older read.
- Control queue waiting is capped at 30 seconds inside the existing 45-second
  assignment retry budget. Three attempts, the actual I/O limit, account/device
  quotas and Feit's two-slot limit remain. Effect frames retain their ordinary
  queue budget; no generic replay of effects or transitions was added.
- Adapter logs now record queue wait, dispatch and delivery classification, so a
  future failure can distinguish local congestion from a wire-level failure.

A mixed nine-target integration case includes five unreachable neighbours,
active polls, and four reachable bulbs with stale offline labels. One operation
observes all four healthy requested states while retaining the five real failures.
It does not resubmit the whole scene or replay successful members. Full validation:
330 tests, TypeScript typecheck and build pass. HTTP outcome fixtures now retain
the attempted transport and failed field instead of claiming no attempt occurred.

This establishes the software scheduling correction. The deployment receipt
records subsequent physical same-state verification through HCP. It does not
guarantee bulb power, Wi-Fi delivery or every future network exchange.
