# Separate observation and log-access identities

The normal collector can read approved Kubernetes resource state but cannot read logs, Secrets, ConfigMap values, or perform writes. On-demand recent logs use an owner-only capability and a separate Kubernetes identity with a bounded, non-persistent response; future restart or rollback behavior must use another audited executor identity rather than expanding either existing credential.
