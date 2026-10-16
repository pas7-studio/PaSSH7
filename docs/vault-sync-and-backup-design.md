# PaSSH7 Vault backup, recovery and safe synchronization

**Status:** Versioned encrypted backup + explicit restore implemented. Automated
cross-device synchronization is **not implemented**.

## Threat model / non-negotiable rules

- The client encrypts the Vault **before** touching any server. Neither the
  frontend, SSH remote host, SFTP server nor synchronization index receives
  private SSH keys, passwords or decoded Vault JSON.
- Every restore is authenticated against the user's unlocked master password.
  Reusing a backup after master-password rotation requires explicitly supplying
  its old master password in a future recovery workflow; it is not currently
  supported as a one-click restore.
- SSH host trust remains pinned; changing a fingerprint is never a sync side
  effect. Restore replaces previously pinned records only after explicit review.
- Remote SFTP file creation uses EXCLUDE/no-overwrite and requests permissions
  0600. SFTP servers may ignore permissions: require a private destination
  directory and independent read-permission verification.
- A remote backup is **not** an independent disaster recovery route if the
  backed-up Vault holds the only working SSH credential to that server. Keep an
  additional offline encrypted copy and separate recovery access.

## Current workflow

1. Unlock a local Vault and connect to an independently verified SSH server.
2. Files -> pick a writable private folder -> **Back up Vault to this server**.
   The native process reads and decrypt-validates the active encrypted envelope,
   creates a new versioned file and verifies exact encrypted-byte readback.
3. Repeat on other personally controlled SSH servers for redundancy, or choose
   **Export local backup** for an offline copy.
4. For recovery, select **Review Vault backup** beside a remote version, or
   choose a previously downloaded/local exported version with **Restore**.
   The native process authenticates the envelope; the UI shows host/key counts
   and selected host aliases but never any private material.
5. Type RESTORE and reconfirm. Under an exclusive local writer lock, the app
   checks that the current ciphertext generation is unchanged. Before replacing
   it, the core stores and verifies a separate copy of the previous ciphertext.
   Old authenticated SSH sessions and port forwards are then stopped.

**No background sync or merge is attempted.** A backup is a recoverable
whole-Vault snapshot and a restore is an explicit replacement.

## Proposed future automatic sync protocol (not shipped)

- **Stable Vault ID**, random **device ID**, and a logical **revision** per
  host/identity/credential record. A global vault revision alone cannot
  resolve concurrent independent device edits.
- An encrypted manifest containing parent revision hashes and a
  content-addressed snapshot identifier; never trust remote timestamps or
  `last-writer-wins` for key or credential deletion.
- An append-only remote history with immutable versioned objects; use an
  exclusive lock or conditional operation where supported. On SFTP servers
  without transactional compare-and-swap, assume concurrent writers and
  reconcile from observed revision ancestry.
- Pull/compare before push. Fast-forward only if the local revision descends
  from the observed remote head; otherwise **pause and show a conflict view**.
  No background overwrite of keys, fingerprints, passwords or deletions.
- Conflict resolution per record with explicit confirmation, plus a preserved
  pre-merge encrypted snapshot. Device revocation and master-password rotation
  require a separate re-encryption/remote-rotation design.
- Scheduling, retry/backoff, retention, remote reachability checks, storage
  quotas, and verified restoration drills must have a reliable local event log.
- Add integration tests with two simultaneous devices, lost acknowledgements,
  reordered uploads, remote file tampering, server quota exhaustion, timeout,
  different passwords and recovery after mid-restore crash.

## Release checklist

- Real Linux + Windows OpenSSH SFTP round trip with private file/directory
  permissions validated on the server, not just CI cross-compilation.
- Confirm no decrypted JSON, private key or saved password in frontend payloads,
  application logs, exception strings or remote file metadata.
- Independently confirm recovery from an offline snapshot on a second device.
- Do not advertise *automatic sync* until concurrent-edit conflict tests pass.
