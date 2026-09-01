# 09: Record structured Experiments

**What to build:** An operator can create and update an Experiment as a structured operational journal and see it alongside Observations in the Timeline. The structure preserves hypothesis, action, evidence, and judgment while still allowing Markdown content.

**Blocked by:** 05: Carry one Pod Observation into the Timeline.

**Status:** ready-for-agent

- [ ] An authorized operator can create an Experiment with hypothesis, change, observation, conclusion, and lifecycle state.
- [ ] Tags, associated workloads, and an optional Git revision can be recorded and updated.
- [ ] Markdown is accepted within structured fields without replacing or collapsing the journal structure.
- [ ] Creating an Experiment atomically creates its Timeline Entry with Workspace identity.
- [ ] Updating an Experiment preserves its identity and associations and rejects invalid lifecycle transitions.
- [ ] A viewer can read permitted Experiments but cannot create or update them.
- [ ] Domain and transport tests exercise meaningful lifecycle and authorization partitions rather than field-by-field implementation details.
- [ ] Playwright demonstrates creation, update, and later retrieval in both supported languages.
