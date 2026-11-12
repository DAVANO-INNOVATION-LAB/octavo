# Package checksum integrity

New Octavo space ZIP exports include `octavo-integrity.json` alongside `octavo.json`. The inventory records schema version 1, SHA-256, the manifest path, and the exact path, byte length and digest of every other ZIP entry, including directory entries if a package supplies them. New Octavo exports contain file entries only. The inventory does not include its own digest.

The import preview shows one of two outcomes:

- **Checksum inventory verified:** the package's file inventory and supplied checksums match. Actual import repeats this check before selecting an import format or writing application data.
- **No verified checksum inventory:** no supported inventory was available. Legacy packages remain importable, but their integrity has not been established by this feature.

A present but invalid inventory is rejected, not treated as a legacy package. Modified payload bytes, missing files, unexpected added entries and invalid inventory data prevent preview confirmation and actual import. Repackaging a modified file with a valid ZIP CRC does not satisfy the SHA-256 inventory check. Validation occurs before format detection, so adding another format's markers must not bypass the check.

## This is unsigned integrity, not authenticity

A matching inventory does not identify the sender, validate the document's factual content or establish trust. Someone who can alter both the files and their checksum inventory can create another matching package. Someone who removes the inventory can make the package appear to be a legacy, unverified import. Without a separately trusted signature or expected digest, that removal cannot be distinguished from an older export. The UI does not label legacy input verified.

The inventory covers entries actually included in this ZIP, not everything referenced by its pages; it is not a complete backup inventory. It does not add attachment packaging, original-upload retention, connector synchronization, source reconstruction or conflict resolution. Existing export content selection and import conversion behavior still apply. Reader exports still omit drafts; the checksums cover only that reader's selected export contents.

The filename `octavo-integrity.json` is reserved for this inventory. Do not use it as an unrelated package file. Keep filenames and exact file bytes intact when transferring an export. If a check fails, obtain the package again from a source you trust rather than deleting its inventory to suppress the failure.

## Access and operation

Export authorization remains unchanged. Private exports require current access, and reader exports contain published content only. Preview and import require an eligible signed-in account. Integrity validation does not grant access or change ownership, space visibility or publication rules.

`npm run test:package-integrity-http` exercises real compiled export/preview/import routes using isolated synthetic data, including re-zipped tampering, missing/extra entries, format-marker bypass attempts, legacy inputs and access boundaries. The browser fixture additionally checks verified, unverified and invalid UI states at desktop and mobile sizes. These checks are not a security certification.

No database migration is required by the checksum inventory itself. Older Octavo versions may ignore the inventory, so their imports should not be assumed to enforce these checks. Keep an independently trusted package copy and test your own transfer and recovery procedure.
