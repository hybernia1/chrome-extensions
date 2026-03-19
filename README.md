# chrome-extensions

## Alza upload endpoint

Repo now also contains a deployable PHP upload endpoint at `server/upload.php`.
Deploy this file to `http://10.3.109.33/faktury/alza/upload.php` so that the extension can upload files directly.

Expected behavior:
- `GET ?invoiceNo=...&orderNo=...&type=pdf|isdoc` returns whether the file already exists on the server
- `POST` multipart/form-data with `invoiceNo`, `orderNo`, `type`, `source`, `sourceUrl`, and `file`
- saves PDFs under `invoice/<orderNo>/<invoiceNo>.pdf`
- saves ISDOC files under `isdoc/<orderNo>/<invoiceNo>.(isdoc|isdocx)`
- returns JSON with `ok`, `stored`, `exists`, and `path`
- the endpoint intentionally accepts uploads without token-based authentication
