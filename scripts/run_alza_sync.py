#!/usr/bin/env python3
"""Open Alza documents in the default browser and keep uploading downloaded files."""

from __future__ import annotations

import argparse
import subprocess
import sys
import time
import webbrowser
from pathlib import Path
from urllib import parse

DEFAULT_DOCUMENTS_URL = "https://www.alza.cz/my-account/documents.htm"
DEFAULT_POLL_INTERVAL = 5
DEFAULT_IDLE_TIMEOUT = 180
DEFAULT_STARTUP_GRACE = 120
DEFAULT_CYCLE_PAUSE_MINUTES = 30


def parse_accounts_file(path: Path) -> list[str]:
    content = path.read_text(encoding="utf-8")
    raw_values = content.replace(",", "\n").splitlines()
    return [value.strip().lower() for value in raw_values if value.strip()]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Otevře Alza doklady v defaultním browseru a průběžně uploaduje stažené soubory přes lokální uploader."
    )
    parser.add_argument(
        "--work-root",
        type=Path,
        default=Path("."),
        help="Kořen lokální pracovní složky se subfolders invoice/ a isdoc/.",
    )
    parser.add_argument(
        "--archive-dir",
        type=Path,
        help="Kam přesouvat úspěšně nahrané soubory. Default je <work-root>/processed.",
    )
    parser.add_argument(
        "--documents-url",
        default=DEFAULT_DOCUMENTS_URL,
        help=f"Základní URL stránky dokladů (default: {DEFAULT_DOCUMENTS_URL}).",
    )
    parser.add_argument(
        "--account-email",
        action="append",
        default=[],
        help="E-mail účtu pro account-cycling. Lze zadat víckrát v pořadí, v jakém se mají účty obcházet.",
    )
    parser.add_argument(
        "--accounts-file",
        type=Path,
        help="Soubor se seznamem účtů (jeden e-mail na řádek nebo čárkami oddělený seznam).",
    )
    parser.add_argument(
        "--cycle-pause-minutes",
        type=int,
        default=DEFAULT_CYCLE_PAUSE_MINUTES,
        help=f"Pauza mezi celými koly účtů (default: {DEFAULT_CYCLE_PAUSE_MINUTES}).",
    )
    parser.add_argument(
        "--poll-interval",
        type=int,
        default=DEFAULT_POLL_INTERVAL,
        help=f"Kolik sekund čekat mezi upload skeny (default: {DEFAULT_POLL_INTERVAL}).",
    )
    parser.add_argument(
        "--idle-timeout",
        type=int,
        default=DEFAULT_IDLE_TIMEOUT,
        help=f"Po kolika sekundách bez nových lokálních souborů běh ukončit (default: {DEFAULT_IDLE_TIMEOUT}).",
    )
    parser.add_argument(
        "--startup-grace",
        type=int,
        default=DEFAULT_STARTUP_GRACE,
        help=f"Minimální doba po startu, po kterou se nevyhodnocuje idle timeout (default: {DEFAULT_STARTUP_GRACE}).",
    )
    parser.add_argument(
        "--endpoint",
        default=None,
        help="Volitelně přepíše endpoint předaný uploaderu.",
    )
    parser.add_argument(
        "--browser-command",
        help="Rezerva do budoucna pro explicitní browser command; aktuálně se používá default browser přes webbrowser.",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Uploader poběží v dry-run režimu, browser se ale otevře normálně.",
    )
    return parser.parse_args()


def build_documents_url(base_url: str) -> str:
    return build_documents_url_with_accounts(base_url, [], DEFAULT_CYCLE_PAUSE_MINUTES)


def build_documents_url_with_accounts(base_url: str, account_emails: list[str], cycle_pause_minutes: int) -> str:
    parsed = parse.urlsplit(base_url)
    query = parse.parse_qs(parsed.query, keep_blank_values=True)
    query["alzaAutoStart"] = ["1"]
    if "alzaAutoMode" not in query:
        query["alzaAutoMode"] = ["both"]
    if account_emails:
        query["alzaAccounts"] = [",".join(account_emails)]
        query["alzaCyclePauseMinutes"] = [str(max(cycle_pause_minutes, 1))]
    return parse.urlunsplit(parsed._replace(query=parse.urlencode(query, doseq=True)))


def count_local_files(root: Path) -> int:
    count = 0
    for subdir, patterns in {
        "invoice": ("*.pdf",),
        "isdoc": ("*.isdoc", "*.isdocx"),
    }.items():
        base = root / subdir
        if not base.exists():
            continue
        for pattern in patterns:
            count += sum(1 for path in base.rglob(pattern) if path.is_file())
    return count


def snapshot_local_files(root: Path) -> tuple[str, ...]:
    files: list[str] = []
    for subdir, patterns in {
        "invoice": ("*.pdf",),
        "isdoc": ("*.isdoc", "*.isdocx"),
    }.items():
        base = root / subdir
        if not base.exists():
            continue
        for pattern in patterns:
            for path in base.rglob(pattern):
                if path.is_file():
                    files.append(str(path.relative_to(root)).replace("\\", "/"))
    return tuple(sorted(files))


def run_uploader(args: argparse.Namespace, work_root: Path, archive_dir: Path) -> subprocess.CompletedProcess[str]:
    script_path = Path(__file__).with_name("upload_local_files.py")
    cmd = [
        sys.executable,
        str(script_path),
        "--root",
        str(work_root),
        "--archive-dir",
        str(archive_dir),
    ]
    if args.endpoint:
        cmd.extend(["--endpoint", args.endpoint])
    if args.dry_run:
        cmd.append("--dry-run")

    return subprocess.run(cmd, check=False, capture_output=True, text=True)


def main() -> int:
    args = parse_args()
    work_root = args.work_root.resolve()
    archive_dir = (args.archive_dir or (work_root / "processed")).resolve()
    archive_dir.mkdir(parents=True, exist_ok=True)

    if args.browser_command:
        print("[WARN] --browser-command je zatím jen příprava do budoucna; používám default browser.")

    account_emails = [email.strip().lower() for email in args.account_email if email and email.strip()]
    if args.accounts_file:
        account_emails.extend(parse_accounts_file(args.accounts_file.resolve()))
    account_emails = list(dict.fromkeys(account_emails))

    documents_url = build_documents_url_with_accounts(args.documents_url, account_emails, args.cycle_pause_minutes)
    print(f"[INFO] Otevírám browser na {documents_url}")
    opened = webbrowser.open(documents_url, new=2)
    if not opened:
        print("[ERR] Nepodařilo se otevřít default browser.", file=sys.stderr)
        return 1

    started_at = time.monotonic()
    last_activity_at = started_at
    previous_snapshot = snapshot_local_files(work_root)
    keep_running = bool(account_emails)

    if keep_running:
        print(
            "[INFO] Multi-account režim aktivní pro účty: "
            + ", ".join(account_emails)
            + ". Idle timeout se v tomto režimu nevynucuje a běh pokračuje stále dokola."
        )

    while True:
        before_count = count_local_files(work_root)
        result = run_uploader(args, work_root, archive_dir)
        after_count = count_local_files(work_root)
        current_snapshot = snapshot_local_files(work_root)

        if result.stdout.strip():
            print(result.stdout.strip())
        if result.stderr.strip():
            print(result.stderr.strip(), file=sys.stderr)

        if result.returncode not in (0,):
            print(f"[ERR] Uploader skončil s kódem {result.returncode}.", file=sys.stderr)

        if (
            before_count != after_count
            or current_snapshot != previous_snapshot
            or "[OK]" in result.stdout
            or "[DRY]" in result.stdout
        ):
            last_activity_at = time.monotonic()
        previous_snapshot = current_snapshot

        if not keep_running:
            elapsed = time.monotonic() - started_at
            idle_for = time.monotonic() - last_activity_at
            if elapsed >= args.startup_grace and idle_for >= args.idle_timeout:
                print(f"[INFO] Idle timeout {args.idle_timeout}s vypršel, workflow končí.")
                return 0

        time.sleep(max(args.poll_interval, 1))


if __name__ == "__main__":
    raise SystemExit(main())
