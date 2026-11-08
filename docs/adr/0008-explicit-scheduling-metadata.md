# ADR 0008 — Explicit scheduling metadata and fairness boundary

Status: approved direction, exact runtime contract/implementation pending P0-28; P0-24 hot reload is prerequisite and operational priority.

Task metadata must be versioned, coordinator/operator-authored and durable. Priority classes: urgent-operational, gate-critical, normal, low. Dependencies explicitly state accepted versus exact-ready evidence; review association includes pinned commit; enqueue timestamps persist across restart. Legacy tasks receive normal/no asserted dependencies, never inferred from prose or timestamps. No worker self-promotion. A lands validated CLI/schema before a delegated pure-policy assignment consumes it.

Eligibility precedes ranking; missing/cyclic refs block only affected tasks. Ranking explains priority, graph-provable unblock and acceptance-review relevance, bounded waiting age and stable FIFO. Aging never bypasses gates/holds/budgets or grants urgent authority. Preserve coordinator capacity, FOUR total jobs, review fairness, immutable active identity/budgets and no preemption. Loaded/disk provenance and evaluation/queue reasons are observable; position is a snapshot, not ETA. A composes the delegated policy and requires actual running-scheduler tests before rollout claims. Do not delay current P0-24 or product reviews to build this feature.
