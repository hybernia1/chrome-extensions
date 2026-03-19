# chrome-extensions

## Alza upload endpoint

Repo now also contains a deployable PHP upload endpoint at `server/upload.php`.
Deploy this file to `http://10.3.109.33/faktury/alza/upload.php` so that the extension can upload files directly.

Expected behavior:
- `POST` multipart/form-data with `invoiceNo`, `orderNo`, `type`, `source`, `sourceUrl`, and `file`
- saves PDFs under `invoice/<orderNo>/<invoiceNo>.pdf`
- saves ISDOC files under `isdoc/<orderNo>/<invoiceNo>.(isdoc|isdocx)`
- returns JSON with `ok`, `stored`, `exists`, and `path`
- optional auth can be enabled via `ALZA_UPLOAD_TOKEN` environment variable and `X-Upload-Token` header
- if token auth is enabled on the server, set the same value in `faktury_downloader/background.js` (`UPLOAD_TOKEN`) or uploads will fail with HTTP 401
