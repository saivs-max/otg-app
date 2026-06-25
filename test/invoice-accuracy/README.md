# Invoice parser accuracy harness

Regression + accuracy gate for the invoice extractors
(`lib/pdfExtractor.js`, `lib/vendorPdfExtractor.js`) and the validation gate
(`lib/invoiceValidation.js`).

## Run

```bash
# put sample invoice PDFs in ./fixtures (git-ignored; real invoices are not committed)
node test/invoice-accuracy/run-accuracy.js

# or point at any folder of PDFs
FIXTURES=/path/to/invoices node test/invoice-accuracy/run-accuracy.js
```

For each PDF it prints: detected kind (vendor/contractor), extracted total, the
validation gate verdict (`auto-ok` / `REVIEW`) and a confidence score. If a
`groundtruth.json` key file is present it also scores total accuracy and exits
non-zero when any total is **confidently wrong** — wire that into CI.

## Ground truth (optional but recommended)

Copy `groundtruth.example.json` to `groundtruth.json` and fill in the verified
values for your fixtures, keyed by filename without `.pdf`:

```json
{ "acme_invoice_001": { "type": "vendor", "gt_total": 426.05 } }
```

`gt_total` is the only field used for scoring; the rest are documentation.

## What "good" looks like

- Every invoice with a **correct, present** total → `auto-ok`.
- Every **scanned / no-text** PDF and every **missing/unsafe** total → `REVIEW`.
- No invoice with a wrong total should ever be `auto-ok`.

Keep adding real-world invoices (especially new vendor layouts and any that get
mis-parsed in production) so the corpus grows into a true regression suite.
