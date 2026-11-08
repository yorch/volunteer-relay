# Synthetic demo files

These are manually authored fictional inputs, separate from the 28-source acceptance benchmark. See [demo instructions](../../docs/demo.md) for the guarded product seed and accounts.

`expected-start.json` is the manually specified starting state: Tidepath has a shared 60-minute activity with two distinct contributions (120 minutes), one 60-minute supply activity, and one pending unknown-duration contribution. Approved totals are therefore 180 minutes, three contributions and two activities. Pending proposals and unknown duration are excluded. The Harbor organization has its own unreviewed source and zero approved minutes.

For imports, choose JSON or CSV in the product Import page, paste the corresponding `updates` file, select ISO dates and `America/New_York`, and use Add author match to connect Demo Volunteer and Demo Coordinator to their named members, following `author-mapping.json`; leave Unknown demo sender unknown. Each file contains three synthetic updates including Spanish and unresolved-author cases. JSON and CSV use different external IDs; importing both creates six inputs rather than being an exact replay. Replay the same unchanged file to demonstrate durable import idempotency. New imports remain queued while external extraction is disabled; the seed's existing proposals are fixtures, not the output of importing these files.

Demo image: `synthetic-supplies.png` is a labeled, programmatically drawn supplies illustration. It is not a real family photo, receipt or proof of hours/identity. It can be used for volunteer photo submission; the seed also stores a normalized private copy on its photo review source.
