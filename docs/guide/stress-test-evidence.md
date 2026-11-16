# Stress-test evidence capture

Every desktop stress run should identify the exact source tree and packaged
components it exercised, and retain raw evidence instead of relying only on a
summary paragraph.

From the repository root:

```powershell
node scripts/stress-test-evidence.mjs --out target/stress-evidence.json `
  --artifact target/stress-run.log `
  --artifact target/durability.csv
```

The manifest records the Git commit and branch, whether the worktree is dirty,
a fingerprint of tracked changes and untracked files, app/Electron versions,
the selected Host Core binary size and SHA-256 when present, runtime versions,
and the size/SHA-256 of every supplied raw log or data file. Artifact paths are
checked before the manifest is written; missing logs are an error, not an empty
success record.

The source fingerprint makes a dirty-tree run distinguishable but does not
replace committing or archiving that source. Preserve the listed raw artifacts
alongside the report. Include the exact test commands, start/end times, and
relevant environment settings in the report; redact secrets before capture.

`node scripts/test-powershell-51-utf8-script.mjs` is a focused Windows
PowerShell 5.1 reproduction check for UTF-8 `.ps1` source with and without a
BOM. It is skipped on non-Windows systems or when the selected Windows
PowerShell is not version 5.1. It tests PowerShell's script-file decoding; it
does not imply that PI's inline Bash command transport corrupts UTF-8.
