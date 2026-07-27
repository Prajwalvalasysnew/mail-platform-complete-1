# Hetzner production foundation

This module provisions three independently backed-up nodes on a private
network, a narrowly scoped firewall, and a public load balancer. It is the
minimum failure-domain shape for the existing Helm chart and CloudNativePG
three-instance manifest; a single VPS is a development deployment and cannot
satisfy the regulated-mode HA prerequisites.

It intentionally does not place secrets, Kubernetes join tokens, database
credentials, or Vault bootstrap material in Terraform state. After applying:

1. Bootstrap an HA k3s control plane over the private addresses using secrets
   delivered from the operator secret manager.
2. Install cert-manager, CloudNativePG, a replicated storage class, and the
   platform Helm chart from `infra/helm/mail-platform`.
3. Point `infra/k8s/postgres-cnpg.yaml` at an independent, versioned object
   store for continuous WAL and base backups.
4. Configure a separate Object-Lock/COMPLIANCE bucket for signed audit
   checkpoints. It must not share credentials or lifecycle policy with body
   storage.
5. Configure Vault Transit or a supported cloud KMS. Never copy the unwrapped
   data key into Terraform variables.
6. Run backup, PITR, and failover drills and attach their signed output to the
   applicable activation evidence records.

Server backups are defense in depth, not the database recovery mechanism.
Regulated activation still requires a measured PITR drill, automatic database
promotion, queue recovery, and independent assessment.
