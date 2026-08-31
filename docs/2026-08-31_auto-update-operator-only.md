# Operator-only auto-update

Robert updates all installed users through Tauri's signed updater. Only YOU can
push an update, because a valid update must be signed with the private key that
never leaves your control.

## The security boundary
- **Public key** is embedded in the app (`tauri.conf.json` > bundle.updater.pubkey).
  It only VERIFIES updates. Safe to be in the public repo / exe.
- **Private key** signs updates. It lives in two places only: `ops/robert_update.key`
  (your machine, outside the app repo) and the GitHub Actions secrets
  `TAURI_SIGNING_PRIVATE_KEY` + `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` (encrypted,
  usable only by CI). It is NOT in the repo and cannot be extracted from the exe.
- Someone who clones the repo or has the installer can verify updates but cannot
  forge one. That is the "only I can push" guarantee.

## How a push works
1. Bump the version in `src-tauri/tauri.conf.json` (and Cargo.toml) — e.g. 0.1.9 -> 0.2.0.
2. Push to `robert-main`. CI builds, SIGNS the installer, and uploads
   `latest.json` + the signed installer to the `v0.1.1` GitHub release.
3. Every running Robert checks `https://github.com/romalonz/robert/releases/latest/download/latest.json`
   on launch, sees the higher version, verifies the signature with the embedded
   public key, and offers "Install & restart" (the green banner).

## If you ever lose the private key
You cannot sign updates anymore and installed users stop updating. Keep
`ops/robert_update.key` + its password backed up. To rotate: generate a new
keypair, ship a build with the new public key, and from then on sign with the
new private key (users must install that build once via a fresh download).
