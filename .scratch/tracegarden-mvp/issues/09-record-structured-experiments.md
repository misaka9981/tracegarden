# 09: Record structured Experiments

**What to build:** An operator can create and update an Experiment as a structured operational journal and see it alongside Observations in the Timeline. The structure preserves hypothesis, action, evidence, and judgment while still allowing Markdown content.

**Blocked by:** 05: Carry one Pod Observation into the Timeline.

**Status:** resolved

- [x] An authorized operator can create an Experiment with hypothesis, change, observation, conclusion, and lifecycle state.
- [x] Tags, associated workloads, and an optional Git revision can be recorded and updated.
- [x] Markdown is accepted within structured fields without replacing or collapsing the journal structure.
- [x] Creating an Experiment atomically creates its Timeline Entry with Workspace identity.
- [x] Updating an Experiment preserves its identity and associations and rejects invalid lifecycle transitions.
- [x] A viewer can read permitted Experiments but cannot create or update them.
- [x] Domain and transport tests exercise meaningful lifecycle and authorization partitions rather than field-by-field implementation details.
- [x] Playwright demonstrates creation, update, and later retrieval in both supported languages.

## Answer

Implemented the ticket 09 review fix: workload form parsing now preserves malformed nonblank lines so rows with missing or extra `|` fields are rejected by domain validation. Added focused form/API coverage for both malformed shapes. Formatting, lint, typecheck, build, unit, browser, and PostgreSQL checks pass under the available runtime.
