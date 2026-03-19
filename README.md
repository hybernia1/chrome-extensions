# chrome-extensions

## Alza upload endpoint

Repo now also contains a deployable PHP upload endpoint at `server/upload.php`.
Deploy this file to `http://10.3.109.33/faktury/alza/upload.php` so that the extension can upload files directly.

Expected behavior:
- `GET ?invoiceNo=...&orderNo=...&type=pdf|isdoc` returns whether the file already exists on the server
- `POST {"action":"check-bulk","items":[{"invoiceNo":"...","orderNo":"..."}]}` returns existence for many invoices in one request
- `POST` multipart/form-data with `invoiceNo`, `orderNo`, `type`, `source`, `sourceUrl`, and `file`
- saves PDFs under `invoice/<orderNo>/<invoiceNo>.pdf`
- saves ISDOC files under `isdoc/<orderNo>/<invoiceNo>.(isdoc|isdocx)`
- returns JSON with `ok`, `stored`, `exists`, and `path`
- the endpoint intentionally accepts uploads without token-based authentication
- if uploads should fall back to reading the already-downloaded local file, enable Chrome extension access to `file://` URLs for this extension

## Python uploader pro lokální soubory

Repo nově obsahuje i dávkový uploader `scripts/upload_local_files.py`, který umí projít lokální složky `invoice/` a `isdoc/`, ověřit přes API, zda už soubor na serveru existuje, a chybějící soubory nahrát.

Příklady:
- `python3 scripts/upload_local_files.py --root /cesta/k/faktury --dry-run`
- `python3 scripts/upload_local_files.py --root /cesta/k/faktury`
- `python3 scripts/upload_local_files.py --root /cesta/k/faktury --archive-dir /cesta/k/archive`
- `python3 scripts/upload_local_files.py --root /cesta/k/faktury --delete-after-upload`

Očekávaná lokální struktura:
- `invoice/<orderNo>/<invoiceNo>.pdf`
- `isdoc/<orderNo>/<invoiceNo>.isdoc`
- `isdoc/<orderNo>/<invoiceNo>.isdocx`
