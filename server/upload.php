<?php

declare(strict_types=1);

header('Content-Type: application/json; charset=utf-8');
header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Methods: POST, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type');

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
    http_response_code(204);
    exit;
}

function respond(int $statusCode, array $payload): void
{
    http_response_code($statusCode);
    echo json_encode($payload, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
}

function request_string(string $key): string
{
    $value = $_POST[$key] ?? '';
    return is_string($value) ? trim($value) : '';
}

function request_json_body(): array
{
    $raw = file_get_contents('php://input');
    if (!is_string($raw) || trim($raw) === '') {
        return [];
    }

    $data = json_decode($raw, true);
    return is_array($data) ? $data : [];
}

function request_param_string(string $key): string
{
    $value = $_REQUEST[$key] ?? '';
    return is_string($value) ? trim($value) : '';
}

function sanitize_digits(string $value): string
{
    return preg_replace('/\D+/', '', $value) ?? '';
}

function ensure_directory(string $path): void
{
    if (is_dir($path)) {
        return;
    }

    if (!mkdir($path, 0775, true) && !is_dir($path)) {
        respond(500, [
            'ok' => false,
            'error' => sprintf('Nepodařilo se vytvořit složku %s.', $path),
        ]);
    }
}

function allowed_extension(string $type, string $originalName, string $mimeType): string
{
    $extension = strtolower(pathinfo($originalName, PATHINFO_EXTENSION));

    if ($type === 'pdf') {
        return 'pdf';
    }

    if (in_array($extension, ['isdoc', 'isdocx'], true)) {
        return $extension;
    }

    if (stripos($mimeType, 'xml') !== false || stripos($mimeType, 'isdoc') !== false) {
        return 'isdoc';
    }

    return 'isdoc';
}

function find_existing_relative_path(string $baseDir, string $orderNo, string $invoiceNo, string $type): ?string
{
    $targetRoot = $type === 'pdf' ? 'invoice' : 'isdoc';
    $targetDir = $baseDir . DIRECTORY_SEPARATOR . $targetRoot . DIRECTORY_SEPARATOR . $orderNo;
    if (!is_dir($targetDir)) {
        return null;
    }

    $patterns = $type === 'pdf'
        ? [$invoiceNo . '.pdf']
        : [$invoiceNo . '.isdoc', $invoiceNo . '.isdocx'];

    foreach ($patterns as $filename) {
        $candidate = $targetDir . DIRECTORY_SEPARATOR . $filename;
        if (is_file($candidate)) {
            return $targetRoot . '/' . $orderNo . '/' . $filename;
        }
    }

    return null;
}

$baseDir = __DIR__;

if ($_SERVER['REQUEST_METHOD'] === 'GET') {
    $invoiceNo = sanitize_digits(request_param_string('invoiceNo'));
    $orderNo = sanitize_digits(request_param_string('orderNo'));
    $type = strtolower(request_param_string('type'));

    if ($invoiceNo === '' || $orderNo === '' || !in_array($type, ['pdf', 'isdoc'], true)) {
        respond(422, [
            'ok' => false,
            'error' => 'Pro kontrolu existence chybí invoiceNo, orderNo nebo type.',
        ]);
    }

    $existingPath = find_existing_relative_path($baseDir, $orderNo, $invoiceNo, $type);
    respond(200, [
        'ok' => true,
        'exists' => $existingPath !== null,
        'path' => $existingPath,
        'invoiceNo' => $invoiceNo,
        'orderNo' => $orderNo,
        'type' => $type,
    ]);
}

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    respond(405, [
        'ok' => false,
        'error' => 'Povolena je pouze metoda POST.',
    ]);
}

$jsonBody = request_json_body();
$action = is_string($jsonBody['action'] ?? null) ? trim($jsonBody['action']) : '';
if ($action === 'check-bulk') {
    $items = is_array($jsonBody['items'] ?? null) ? $jsonBody['items'] : [];
    $results = [];

    foreach ($items as $item) {
        if (!is_array($item)) {
            continue;
        }

        $invoiceNo = sanitize_digits((string) ($item['invoiceNo'] ?? ''));
        $orderNo = sanitize_digits((string) ($item['orderNo'] ?? ''));
        if ($invoiceNo === '' || $orderNo === '') {
            continue;
        }

        $pdfPath = find_existing_relative_path($baseDir, $orderNo, $invoiceNo, 'pdf');
        $isdocPath = find_existing_relative_path($baseDir, $orderNo, $invoiceNo, 'isdoc');

        $results[$invoiceNo] = [
            'invoiceNo' => $invoiceNo,
            'orderNo' => $orderNo,
            'pdf' => [
                'exists' => $pdfPath !== null,
                'path' => $pdfPath,
            ],
            'isdoc' => [
                'exists' => $isdocPath !== null,
                'path' => $isdocPath,
            ],
        ];
    }

    respond(200, [
        'ok' => true,
        'results' => $results,
    ]);
}

$invoiceNo = sanitize_digits(request_string('invoiceNo'));
$orderNo = sanitize_digits(request_string('orderNo'));
$type = strtolower(request_string('type'));
$source = request_string('source');
$sourceUrl = request_string('sourceUrl');

if ($invoiceNo === '' || $orderNo === '') {
    respond(422, [
        'ok' => false,
        'error' => 'Chybí invoiceNo nebo orderNo.',
    ]);
}

if (!in_array($type, ['pdf', 'isdoc'], true)) {
    respond(422, [
        'ok' => false,
        'error' => 'Neplatný typ souboru.',
    ]);
}

if (!isset($_FILES['file']) || !is_array($_FILES['file'])) {
    respond(422, [
        'ok' => false,
        'error' => 'Soubor nebyl odeslán.',
    ]);
}

$file = $_FILES['file'];
if (($file['error'] ?? UPLOAD_ERR_NO_FILE) !== UPLOAD_ERR_OK) {
    respond(422, [
        'ok' => false,
        'error' => 'Upload souboru selhal.',
        'phpUploadError' => $file['error'] ?? null,
    ]);
}

$tmpName = $file['tmp_name'] ?? '';
$originalName = is_string($file['name'] ?? null) ? $file['name'] : '';
$mimeType = is_string($file['type'] ?? null) ? $file['type'] : '';
$extension = allowed_extension($type, $originalName, $mimeType);

$targetRoot = $type === 'pdf' ? 'invoice' : 'isdoc';
$targetDir = $baseDir . DIRECTORY_SEPARATOR . $targetRoot . DIRECTORY_SEPARATOR . $orderNo;
$targetFile = $targetDir . DIRECTORY_SEPARATOR . $invoiceNo . '.' . $extension;
$relativePath = $targetRoot . '/' . $orderNo . '/' . $invoiceNo . '.' . $extension;

ensure_directory($targetDir);

if (is_file($targetFile)) {
    respond(200, [
        'ok' => true,
        'stored' => false,
        'exists' => true,
        'path' => $relativePath,
        'invoiceNo' => $invoiceNo,
        'orderNo' => $orderNo,
        'type' => $type,
        'source' => $source,
        'sourceUrl' => $sourceUrl,
    ]);
}

if (!is_uploaded_file($tmpName) || !move_uploaded_file($tmpName, $targetFile)) {
    respond(500, [
        'ok' => false,
        'error' => 'Soubor se nepodařilo uložit.',
    ]);
}

chmod($targetFile, 0664);

respond(200, [
    'ok' => true,
    'stored' => true,
    'exists' => false,
    'path' => $relativePath,
    'invoiceNo' => $invoiceNo,
    'orderNo' => $orderNo,
    'type' => $type,
    'source' => $source,
    'sourceUrl' => $sourceUrl,
    'size' => filesize($targetFile),
]);
