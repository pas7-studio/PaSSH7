# PaSSH7 Vault Compatibility Contract (ADR-0001)

Status: **adopted for v0.1 development**, unverified on Rust/Windows runners.

## Two independent versions

1. **Envelope `format`** describes KDF, salt, nonce, encryption algorithm, and authenticated ciphertext. Current value `1`; associated data: `passh7/vault/v1`.
2. **Plaintext `schema_version`** describes hosts, identities and future application records. Current value `1`. Old payloads with *no* `schema_version` are read as v1.

Never interpret these as the same version. Envelope changes require an explicit decrypt/re-encrypt path. Schema migrations may change the plaintext without changing the envelope format.

## Compatibility guarantees

- An older v1 vault with `hosts` and `identities` but no schema marker must load as schema v1.
- New optional fields at vault/host/identity level survive decrypt/serialize/encrypt without being silently removed.
- Unknown **schema_version** is rejected; **never downgrade** or overwrite future data.
- Named references from host to identity must remain valid. Aliases remain user-facing v1 references; immutable UUID identifiers will need a dedicated migration before renaming semantics are added.
- Preserve the encrypted bytes of the prior generation before applying an actual migration. Do not remove backups until an independently verified restore has succeeded.
- Avoid silently changing serialization keys; aliases, enum variants and field names are part of the format contract.
- Export/import and any later database conversion must retain unknown extension fields.

## Safe migration transaction (future implementation)

1. Acquire an exclusive per-vault writer lock.
2. Read original bytes, enforce size and envelope-version limits, decrypt/authenticate, inspect plaintext schema.
3. Reject unsupported versions; validate all records and references.
4. Create a uniquely named encrypted backup in the same protected directory and sync it.
5. Apply **one explicit** migration (e.g., v1 -> v2) on a cloned in-memory model.
6. Validate the full migrated model, encrypt to a new temporary file, sync.
7. Atomically replace the destination with platform-specific APIs; sync directory where supported.
8. Independently read/decrypt the final file and verify schema/data invariants.
9. Release writer lock, record non-secret migration metadata. Retain backup until recovery policy permits deletion.

The current v0.1 code implements only part of this process. In particular, it does **not** guarantee concurrent-writer safety, Windows ACL preservation, crash-safe rollback or verified backup recovery. Do not claim it is complete or production safe.

## Test gates for each future schema change

- Golden fixtures from every released format.
- Upward conversion from N-1 and all supported earlier versions.
- Read/write round-trip with unknown optional fields at every object level.
- No write on unsupported future versions or wrong password.
- Failures injected before and after temp write, backup, replace and verify.
- Windows NTFS and Linux ext4 tests for interrupted replacement, ACLs and locked files.
- Restore validation for old backups with old master passwords.
- Concurrency tests for two CLI/UI/MCP writers modifying the same vault.
- Compare full semantic records, not just counts, after migration.

## Agent-facing separation

MCP permissions and runtime sessions must never be persisted inside the core vault in a way that forces rewriting private identities on every agent event. Store separate agent policy/audit records with their own schemas. Do not expose serialized Vault or private key material as MCP tool output.

## Writer serialization (implementation added, validation pending)

All CLI read-modify-write operations now pass through `passh7_core::transaction`, which acquires an OS advisory exclusive lock on a stable `*.passh7.lock` sidecar file *before reading* the encrypted vault and keeps it through replacement. Password rotation uses the same lock.

The lock protects only **cooperating** PaSSH7 writers. External tools, manual edits, sync software and clients using the raw public `save` function can bypass it. This still needs lock-file symlink/reparse-point hardening, directory ACLs, crash/recovery tests, and checks on real Windows filesystems. Do not place the vault on SMB/network storage or cloud-sync folders at this stage.

## Long-lived object identifiers

A future v2 migration should assign random immutable UUIDs to identities and hosts, make aliases mutable display names, and convert host-to-identity links to UUID references. Do not infer stable IDs from alias, hostname or positional index; these can change or collide. Keep original aliases as display values and preserve a reversible mapping for exports. **No UUID migration is performed by v0.1**; avoid silent on-read mutations.
