#!/usr/bin/env python3
"""Upload locally downloaded invoice/ISDOC files to the existing HTTP API.

Expected local layout under --root:
  invoice/<orderNo>/<invoiceNo>.pdf
  isdoc/<orderNo>/<invoiceNo>.isdoc
  isdoc/<orderNo>/<invoiceNo>.isdocx
"""

from __future__ import annotations

import argparse
import json
import mimetypes
import shutil
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable
from urllib import error, parse, request

DEFAULT_ENDPOINT = "http://10.3.109.33/faktury/alza/upload.php"
SOURCE_LABEL = "python-uploader"
BOUNDARY = "----AlzaUploaderBoundary7MA4YWxkTrZu0gW"


@dataclass(frozen=True)
class CandidateFile:
    path: Path
    order_no: str
    invoice_no: str
    type: str


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Nahraje lokální PDF/ISDOC soubory přes existující Alza upload API."
    )
    parser.add_argument(
        "--root",
        type=Path,
        default=Path("."),
        help="Kořen se složkami invoice/ a isdoc/ (default: aktuální adresář).",
    )
    parser.add_argument(
        "--endpoint",
        default=DEFAULT_ENDPOINT,
        help=f"URL upload API (default: {DEFAULT_ENDPOINT}).",
    )
    parser.add_argument(
        "--delete-after-upload",
        action="store_true",
        help="Po úspěšném uploadu lokální soubor smazat.",
    )
    parser.add_argument(
        "--archive-dir",
        type=Path,
        help="Po úspěšném uploadu přesunout soubor do archivu místo mazání.",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Jen vypíše, co by se uploadovalo; nic neposílá.",
    )
    parser.add_argument(
        "--verbose",
        action="store_true",
        help="Podrobnější logování přeskočených souborů a odpovědí API.",
    )
    args = parser.parse_args()
    if args.delete_after_upload and args.archive_dir:
        parser.error("Použij buď --delete-after-upload, nebo --archive-dir, ne oboje zároveň.")
    return args


def sanitize_digits(value: str) -> str:
    return "".join(ch for ch in value if ch.isdigit())


def iter_candidate_files(root: Path) -> Iterable[CandidateFile]:
    for type_name, exts in {
        "pdf": {".pdf"},
        "isdoc": {".isdoc", ".isdocx"},
    }.items():
        base_dir = root / ("invoice" if type_name == "pdf" else "isdoc")
        if not base_dir.exists():
            continue

        for path in sorted(base_dir.rglob("*")):
            if not path.is_file():
                continue
            if path.suffix.lower() not in exts:
                continue

            try:
                relative = path.relative_to(base_dir)
            except ValueError:
                continue

            if len(relative.parts) != 2:
                continue

            order_raw, filename = relative.parts
            order_no = sanitize_digits(order_raw)
            invoice_no = sanitize_digits(Path(filename).stem)
            if not order_no or not invoice_no:
                continue

            yield CandidateFile(
                path=path,
                order_no=order_no,
                invoice_no=invoice_no,
                type=type_name,
            )


def api_get_json(url: str) -> dict:
    req = request.Request(url, method="GET")
    with request.urlopen(req, timeout=30) as response:
        data = response.read().decode("utf-8")
        return json.loads(data) if data else {}


def build_multipart_body(fields: dict[str, str], file_field_name: str, candidate: CandidateFile) -> tuple[bytes, str]:
    body = bytearray()
    boundary_bytes = BOUNDARY.encode("utf-8")

    for key, value in fields.items():
        body.extend(b"--" + boundary_bytes + b"\r\n")
        body.extend(f'Content-Disposition: form-data; name="{key}"\r\n\r\n'.encode("utf-8"))
        body.extend(value.encode("utf-8"))
        body.extend(b"\r\n")

    mime_type = mimetypes.guess_type(candidate.path.name)[0] or "application/octet-stream"
    file_bytes = candidate.path.read_bytes()
    body.extend(b"--" + boundary_bytes + b"\r\n")
    body.extend(
        (
            f'Content-Disposition: form-data; name="{file_field_name}"; '
            f'filename="{candidate.path.name}"\r\n'
        ).encode("utf-8")
    )
    body.extend(f"Content-Type: {mime_type}\r\n\r\n".encode("utf-8"))
    body.extend(file_bytes)
    body.extend(b"\r\n")
    body.extend(b"--" + boundary_bytes + b"--\r\n")
    return bytes(body), f"multipart/form-data; boundary={BOUNDARY}"


def api_check_exists(endpoint: str, candidate: CandidateFile) -> dict:
    query = parse.urlencode(
        {
            "invoiceNo": candidate.invoice_no,
            "orderNo": candidate.order_no,
            "type": candidate.type,
        }
    )
    return api_get_json(f"{endpoint}?{query}")


def api_upload(endpoint: str, candidate: CandidateFile) -> dict:
    body, content_type = build_multipart_body(
        {
            "invoiceNo": candidate.invoice_no,
            "orderNo": candidate.order_no,
            "type": candidate.type,
            "source": SOURCE_LABEL,
            "sourceUrl": "",
        },
        "file",
        candidate,
    )
    req = request.Request(
        endpoint,
        data=body,
        method="POST",
        headers={"Content-Type": content_type, "Content-Length": str(len(body))},
    )
    with request.urlopen(req, timeout=120) as response:
        data = response.read().decode("utf-8")
        return json.loads(data) if data else {}


def archive_path_for(candidate: CandidateFile, archive_dir: Path) -> Path:
    root_name = "invoice" if candidate.type == "pdf" else "isdoc"
    return archive_dir / root_name / candidate.order_no / candidate.path.name


def remove_empty_parent_dirs(candidate: CandidateFile) -> None:
    stop_dir = candidate.path.parents[1]
    current = candidate.path.parent

    while current != stop_dir:
        if current.exists():
            try:
                current.rmdir()
            except OSError:
                break
        current = current.parent

    if current.exists():
        try:
            current.rmdir()
        except OSError:
            pass


def finalize_uploaded_file(candidate: CandidateFile, args: argparse.Namespace) -> None:
    if args.delete_after_upload:
        candidate.path.unlink(missing_ok=True)
        remove_empty_parent_dirs(candidate)
        return

    if args.archive_dir:
        target = archive_path_for(candidate, args.archive_dir)
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.move(str(candidate.path), str(target))
        remove_empty_parent_dirs(candidate)


def process_candidate(candidate: CandidateFile, args: argparse.Namespace) -> tuple[str, str]:
    label = f"{candidate.type.upper()} {candidate.invoice_no} / {candidate.order_no}"
    if args.dry_run:
        return "DRY", f"{label}: {candidate.path}"

    check = api_check_exists(args.endpoint, candidate)
    if check.get("exists"):
        return "SKIP", f"{label}: už existuje na serveru jako {check.get('path') or '-'}"

    upload = api_upload(args.endpoint, candidate)
    if not upload.get("ok"):
        raise RuntimeError(upload.get("error") or f"Upload {label} selhal bez detailu.")

    finalize_uploaded_file(candidate, args)
    return "OK", f"{label}: nahráno jako {upload.get('path') or '-'}"


def main() -> int:
    args = parse_args()
    root = args.root.resolve()
    candidates = list(iter_candidate_files(root))

    if not candidates:
        print(f"Nenalezeny žádné soubory v {root} (čekám invoice/ a isdoc/).")
        return 0

    ok_count = 0
    skip_count = 0
    fail_count = 0

    for candidate in candidates:
        try:
            status, message = process_candidate(candidate, args)
            print(f"[{status}] {message}")
            if status == "OK":
                ok_count += 1
            elif status == "SKIP":
                skip_count += 1
        except error.HTTPError as exc:
            fail_count += 1
            payload = exc.read().decode("utf-8", errors="replace")
            print(f"[ERR] {candidate.path}: HTTP {exc.code} {payload}", file=sys.stderr)
        except error.URLError as exc:
            fail_count += 1
            print(f"[ERR] {candidate.path}: Nelze se spojit s API ({exc.reason}).", file=sys.stderr)
        except Exception as exc:  # noqa: BLE001 - chceme robustní dávkové zpracování
            fail_count += 1
            print(f"[ERR] {candidate.path}: {exc}", file=sys.stderr)

    print(f"Hotovo: OK={ok_count}, SKIP={skip_count}, ERR={fail_count}")
    return 1 if fail_count else 0


if __name__ == "__main__":
    raise SystemExit(main())
