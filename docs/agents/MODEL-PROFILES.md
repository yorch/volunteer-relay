# Proposed profiles — no live changes

Official model-selection guidance describes Sol for complex technical work, Terra for visual/computer-use tasks, Luna for scoped efficient work and Astra for demanding reasoning. Source checked2026-11-07: [OpenAI model selection](https://developers.openai.com/api/docs/guides/model-selection). These role/effort assignments are our proposed evaluation policy, not a guarantee from documentation or account access. Cached IDs are not access guarantees.

| Role/task                               | Proposed model | Effort                          |
| --------------------------------------- | -------------- | ------------------------------- |
| A short control triage/composition      | gpt-6.1-sol    | medium; high for architecture   |
| B auth/security/domain                  | gpt-6.1-sol    | high                            |
| UI/tooling implementation               | gpt-6.1-sol    | medium                          |
| Constrained visual fixes / V            | gpt-6.1-terra  | medium                          |
| R auth/tenant/migration critical review | gpt-6-astra    | high                            |
| R routine review                        | gpt-6.1-sol    | high                            |
| Bounded docs/fixtures/triage trial only | gpt-6-luna     | medium after quality comparison |

Do not silently switch current runs/defaults/harnesses. Check installed supported model/effort semantics, approve an explicit task profile, then use a fresh native session at an idle/drained safe boundary with recorded configured/observed provenance. Pi is presently tool-free and unsuitable for writer/browser workloads. No child agents or extra slots.

Compare matched bounded tasks with same acceptance gate and input scope. Record queued/start/finish/accept timestamps, wall/queue/acceptance latency, cached/uncached input and output only where native metadata supports them, rework cycles, ranked review defects, test failures and successful acceptance. Prefer time/quality/cost per accepted task; do not equate low raw tokens with cheaper or better delivery. Never infer billing from saved-plan authentication or model cache; monetary cost remains unavailable unless actual attributable billing is supplied. Preserve unsuccessful/blocked runs and coverage limits. Begin with a small matched quality comparison before allowing Luna beyond low-risk scopes.
