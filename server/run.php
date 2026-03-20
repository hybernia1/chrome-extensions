<?php

declare(strict_types=1);

header('Content-Type: application/json; charset=utf-8');
header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Methods: GET, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type');

if (($_SERVER['REQUEST_METHOD'] ?? 'GET') === 'OPTIONS') {
    http_response_code(204);
    exit;
}

function respond(int $statusCode, array $payload): void
{
    http_response_code($statusCode);
    echo json_encode($payload, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_PRETTY_PRINT);
    exit;
}

function request_param_string(string $key): string
{
    $value = $_REQUEST[$key] ?? '';
    return is_string($value) ? trim($value) : '';
}

function sanitize_order_number(string $value): string
{
    return preg_replace('/[^A-Za-z0-9_-]+/', '', $value) ?? '';
}

function relative_path(string $baseDir, string $fullPath): string
{
    $normalizedBase = rtrim(str_replace('\\', '/', $baseDir), '/');
    $normalizedPath = str_replace('\\', '/', $fullPath);

    if (str_starts_with($normalizedPath, $normalizedBase . '/')) {
        return substr($normalizedPath, strlen($normalizedBase) + 1);
    }

    return $normalizedPath;
}

function first_matching_file(string $directory, array $extensions): ?string
{
    if (!is_dir($directory)) {
        return null;
    }

    $allowed = array_map('strtolower', $extensions);
    $items = scandir($directory);
    if ($items === false) {
        return null;
    }

    foreach ($items as $item) {
        if ($item === '.' || $item === '..') {
            continue;
        }

        $path = $directory . DIRECTORY_SEPARATOR . $item;
        if (!is_file($path)) {
            continue;
        }

        $extension = strtolower(pathinfo($path, PATHINFO_EXTENSION));
        if (in_array($extension, $allowed, true)) {
            return $path;
        }
    }

    return null;
}

function load_isdoc_xml(string $filePath): ?string
{
    $extension = strtolower(pathinfo($filePath, PATHINFO_EXTENSION));
    if ($extension === 'isdoc') {
        $content = file_get_contents($filePath);
        return is_string($content) ? $content : null;
    }

    if ($extension !== 'isdocx' || !class_exists('ZipArchive')) {
        return null;
    }

    $zip = new ZipArchive();
    if ($zip->open($filePath) !== true) {
        return null;
    }

    $xml = null;
    for ($i = 0; $i < $zip->numFiles; $i++) {
        $name = $zip->getNameIndex($i);
        if (!is_string($name)) {
            continue;
        }

        if (preg_match('~(^|/)(isdoc|invoice)\.xml$~i', $name) === 1 || str_ends_with(strtolower($name), '.xml')) {
            $content = $zip->getFromIndex($i);
            if (is_string($content) && trim($content) !== '') {
                $xml = $content;
                break;
            }
        }
    }

    $zip->close();
    return $xml;
}

function xml_value(DOMXPath $xpath, string $expression): ?string
{
    $value = trim((string) $xpath->evaluate("string($expression)"));
    return $value === '' ? null : $value;
}

function parse_isdoc_details(string $filePath): array
{
    $xmlContent = load_isdoc_xml($filePath);
    if ($xmlContent === null || trim($xmlContent) === '') {
        return [
            'ok' => false,
            'error' => 'ISDOC soubor se nepodařilo načíst.',
        ];
    }

    libxml_use_internal_errors(true);
    $document = new DOMDocument();
    if (!$document->loadXML($xmlContent)) {
        libxml_clear_errors();
        return [
            'ok' => false,
            'error' => 'ISDOC XML není platný.',
        ];
    }
    libxml_clear_errors();

    $xpath = new DOMXPath($document);
    $xpath->registerNamespace('isdoc', 'http://isdoc.cz/namespace/2013');
    $xpath->registerNamespace('isdoc6', 'http://isdoc.cz/namespace/2007');

    $ico = xml_value($xpath, '//*[local-name()="PartyTaxScheme"]/*[local-name()="CompanyID"][1]');
    $user = xml_value($xpath, '//*[local-name()="PartyIdentification"]/*[local-name()="UserID"][1]');

    return [
        'ok' => true,
        'ico' => $ico,
        'user' => $user,
    ];
}

$baseDir = __DIR__;

if (($_SERVER['REQUEST_METHOD'] ?? 'GET') !== 'GET') {
    respond(405, [
        'ok' => false,
        'error' => 'Povolena je pouze metoda GET.',
    ]);
}

$orderNo = sanitize_order_number(request_param_string('orderNo'));
if ($orderNo === '') {
    respond(422, [
        'ok' => false,
        'error' => 'Chybí order number.',
    ]);
}

$pdfPath = first_matching_file($baseDir . DIRECTORY_SEPARATOR . 'invoice' . DIRECTORY_SEPARATOR . $orderNo, ['pdf']);
$isdocPath = first_matching_file($baseDir . DIRECTORY_SEPARATOR . 'isdoc' . DIRECTORY_SEPARATOR . $orderNo, ['isdoc', 'isdocx']);

$isdocDetails = null;
if ($isdocPath !== null) {
    $isdocDetails = parse_isdoc_details($isdocPath);
}

respond(200, [
    'ok' => true,
    'orderNo' => $orderNo,
    'pdf' => [
        'exists' => $pdfPath !== null,
        'path' => $pdfPath !== null ? relative_path($baseDir, $pdfPath) : null,
    ],
    'isdoc' => [
        'exists' => $isdocPath !== null,
        'path' => $isdocPath !== null ? relative_path($baseDir, $isdocPath) : null,
        'details' => $isdocDetails,
    ],
]);
