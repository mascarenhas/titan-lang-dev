#!/usr/bin/env python3
"""Verify compiled PDF book structure, bookmarks, internal links, same-site URIs/fragments, and size limits."""
import argparse
import html
import json
import os
import re
import shutil
import subprocess
import xml.etree.ElementTree as ET
import sys
from urllib.parse import unquote, urlsplit

try:
    from pypdf import PdfReader
except ImportError:
    sys.stderr.write(
        "[verify-pdf] ERROR: Python package `pypdf` is required.\n"
        "Install it with `pip install pypdf` or run with `PYTHON_BIN=/path/to/venv/bin/python`.\n"
    )
    sys.exit(1)

CF_MAX_ASSET_BYTES = 25 * 1024 * 1024  # 26,214,400 bytes
DEFAULT_MIN_OUTLINE_ENTRIES = 650
SCRIPT_STYLE_RE = re.compile(r"<(?:script|style)\b[^>]*>[\s\S]*?</(?:script|style)>", re.IGNORECASE)
ID_ATTR_RE = re.compile(r'\bid=(?:"([^"]+)"|\'([^\']+)\')', re.IGNORECASE)


def build_dist_index(dist_dir):
    """Return exact case-sensitive relative file paths inside `dist_dir`."""
    files = set()
    for root, _, filenames in os.walk(dist_dir):
        for fname in filenames:
            abs_path = os.path.join(root, fname)
            rel = os.path.relpath(abs_path, dist_dir).replace(os.sep, "/")
            files.add(rel)
    return files


def resolve_dist_file(pathname, dist_files):
    clean = unquote(pathname).lstrip("/")
    if clean == "":
        return "index.html" if "index.html" in dist_files else None
    if clean.endswith("/"):
        idx = f"{clean}index.html"
        return idx if idx in dist_files else None
    if clean in dist_files:
        return clean
    idx = f"{clean}/index.html"
    if idx in dist_files:
        return idx
    return None


def extract_html_ids(html_path, cache):
    if html_path in cache:
        return cache[html_path]
    with open(html_path, "r", encoding="utf-8") as fh:
        raw = fh.read()
    stripped = SCRIPT_STYLE_RE.sub("", raw)
    ids = set()
    for m in ID_ATTR_RE.finditer(stripped):
        val = html.unescape(m.group(1) if m.group(1) is not None else m.group(2))
        if val:
            ids.add(val)
    cache[html_path] = ids
    return ids


def walk_outline(reader, items, depth=0, stats=None):
    if stats is None:
        stats = {"total": 0, "by_depth": {}, "invalid_dests": 0}
    num_pages = len(reader.pages)
    for item in items:
        if isinstance(item, list):
            walk_outline(reader, item, depth + 1, stats)
        else:
            stats["total"] += 1
            key = str(depth)
            stats["by_depth"][key] = stats["by_depth"].get(key, 0) + 1
            try:
                page_num = reader.get_destination_page_number(item)
                if page_num is None or page_num < 0 or page_num >= num_pages:
                    stats["invalid_dests"] += 1
            except Exception:
                stats["invalid_dests"] += 1
    return stats


def check_horizontal_word_overlaps(pdf_path):
    """Detect horizontal glyph/word overlaps across all PDF pages via `pdftotext -bbox-layout`."""
    if not shutil.which("pdftotext"):
        return None, "Required tool `pdftotext` (poppler-utils) not found on PATH for PDF overlap audit"
    bbox_xml = subprocess.check_output(["pdftotext", "-bbox-layout", pdf_path, "-"], text=True)
    root = ET.fromstring(bbox_xml)
    ns = {"x": "http://www.w3.org/1999/xhtml"}
    overlaps = []
    for pidx, page in enumerate(root.findall(".//x:page", ns), start=1):
        words = []
        for w in page.findall(".//x:word", ns):
            x0 = float(w.attrib["xMin"])
            y0 = float(w.attrib["yMin"])
            x1 = float(w.attrib["xMax"])
            y1 = float(w.attrib["yMax"])
            words.append((x0, y0, x1, y1, w.text or ""))
        words.sort(key=lambda t: (t[1], t[0]))
        for i in range(len(words)):
            ax0, ay0, ax1, ay1, at = words[i]
            ah = ay1 - ay0
            if ah <= 0:
                continue
            for j in range(i + 1, len(words)):
                bx0, by0, bx1, by1, bt = words[j]
                if by0 > ay1:
                    break
                bh = by1 - by0
                if bh <= 0:
                    continue
                v_ov = min(ay1, by1) - max(ay0, by0)
                if v_ov / min(ah, bh) > 0.45:
                    h_ov = min(ax1, bx1) - max(ax0, bx0)
                    if h_ov > 1.5:
                        overlaps.append((pidx, round(h_ov, 1), at, bt))
    return overlaps, None

def verify_pdf(pdf_path, dist_dir=None, site_origin=None, min_outline=DEFAULT_MIN_OUTLINE_ENTRIES, meta_path=None):
    errors = []
    if not os.path.isfile(pdf_path):
        sys.stderr.write(f"[verify-pdf] ERROR: PDF not found: {pdf_path}\n")
        return 1

    size_bytes = os.path.getsize(pdf_path)
    if size_bytes >= CF_MAX_ASSET_BYTES:
        errors.append(
            f"PDF size {size_bytes / 1048576:.2f} MiB reaches/exceeds Cloudflare 25 MiB limit"
        )

    dist_files = None
    html_id_cache = {}
    parsed_origin = None
    if dist_dir and site_origin:
        if not os.path.isdir(dist_dir):
            errors.append(f"Site dist directory not found for PDF URI check: {dist_dir}")
        else:
            dist_files = build_dist_index(dist_dir)
            parsed_origin = urlsplit(site_origin.rstrip("/"))

    reader = PdfReader(pdf_path)
    num_pages = len(reader.pages)
    if num_pages <= 0:
        errors.append("PDF has 0 pages")

    outline_stats = walk_outline(reader, reader.outline)
    if outline_stats["total"] <= min_outline:
        errors.append(
            f"PDF outline has {outline_stats['total']} bookmarks (expected > {min_outline})"
        )
    if outline_stats["invalid_dests"] != 0:
        errors.append(f"PDF outline has {outline_stats['invalid_dests']} invalid destinations")

    internal_valid = 0
    internal_broken = []
    external_uri = 0
    site_uris_checked = 0
    site_uri_fragments_checked = 0
    site_uris_broken = []
    page_by_id = {p.indirect_reference.idnum: idx for idx, p in enumerate(reader.pages)}
    named_dests = reader.named_destinations or {}

    for p_idx, page in enumerate(reader.pages):
        annots = page.get("/Annots")
        if not annots:
            continue
        for a_ref in annots:
            annot = a_ref.get_object()
            if annot.get("/Subtype") != "/Link":
                continue
            action = annot.get("/A")
            dest = annot.get("/Dest")
            if action:
                action = action.get_object()
                s = action.get("/S")
                if s == "/URI":
                    external_uri += 1
                    raw_uri = action.get("/URI")
                    uri_str = str(raw_uri) if raw_uri is not None else ""
                    if dist_files is not None and parsed_origin is not None and uri_str:
                        parts = urlsplit(uri_str)
                        if (
                            parts.scheme.lower() == parsed_origin.scheme.lower()
                            and parts.netloc.lower() == parsed_origin.netloc.lower()
                        ):
                            site_uris_checked += 1
                            rel_file = resolve_dist_file(parts.path or "/", dist_files)
                            if not rel_file:
                                site_uris_broken.append((p_idx + 1, uri_str, "missing route/file in dist"))
                            elif parts.fragment:
                                site_uri_fragments_checked += 1
                                frag = unquote(parts.fragment)
                                if rel_file.endswith(".html"):
                                    ids = extract_html_ids(os.path.join(dist_dir, rel_file), html_id_cache)
                                    if frag not in ids:
                                        site_uris_broken.append(
                                            (p_idx + 1, uri_str, f"dist/{rel_file} lacks id=\"{frag}\"")
                                        )
                    continue
                if s == "/GoTo":
                    dest = action.get("/D")
            if dest is not None:
                if hasattr(dest, "get_object"):
                    dest = dest.get_object()
                target_page_idx = None
                if isinstance(dest, str):
                    if dest in named_dests:
                        target_page_idx = reader.get_destination_page_number(named_dests[dest])
                elif isinstance(dest, list) and len(dest) >= 1:
                    page_ref = dest[0]
                    if hasattr(page_ref, "idnum") and page_ref.idnum in page_by_id:
                        target_page_idx = page_by_id[page_ref.idnum]
                    elif isinstance(page_ref, int) and 0 <= page_ref < num_pages:
                        target_page_idx = page_ref
                if target_page_idx is not None and 0 <= target_page_idx < num_pages:
                    internal_valid += 1
                else:
                    internal_broken.append((p_idx + 1, repr(dest)))

    if internal_broken:
        errors.append(
            f"Found {len(internal_broken)} broken internal PDF link annotation(s): {internal_broken[:5]}"
        )
    if site_uris_broken:
        errors.append(
            f"Found {len(site_uris_broken)} broken same-site PDF URI(s): {site_uris_broken[:5]}"
        )

    # Audit embedded font families across all pages (must be Source Serif 4 / IBM Plex only)
    embedded_fonts = set()
    fallback_fonts = set()
    for page in reader.pages:
        res = page.get("/Resources")
        if not res:
            continue
        fonts = res.get("/Font")
        if not fonts:
            continue
        fonts_obj = fonts.get_object() if hasattr(fonts, "get_object") else fonts
        for fref in fonts_obj.values():
            fobj = fref.get_object() if hasattr(fref, "get_object") else fref
            bf = str(fobj.get("/BaseFont", "")).lstrip("/")
            clean_name = bf.split("+", 1)[1] if "+" in bf else bf
            if clean_name:
                embedded_fonts.add(clean_name)
                if not (clean_name.startswith("SourceSerif4") or clean_name.startswith("IBMPlex")):
                    fallback_fonts.add(clean_name)
    if fallback_fonts:
        errors.append(
            f"Found unexpected fallback font(s) embedded in PDF: {sorted(fallback_fonts)}"
        )

    if meta_path:
        if not os.path.isfile(meta_path):
            errors.append(f"Missing PDF metadata file: {meta_path}")
        else:
            with open(meta_path, "r", encoding="utf-8") as mf:
                meta = json.load(mf)
            if meta.get("pages") != num_pages:
                errors.append(
                    f"PDF metadata page count mismatch: {meta_path} says {meta.get('pages')}, actual PDF has {num_pages}"
                )
            if meta.get("sizeBytes") != size_bytes:
                errors.append(
                    f"PDF metadata sizeBytes mismatch: {meta_path} says {meta.get('sizeBytes')}, actual PDF is {size_bytes}"
                )

    word_overlaps, overlap_err = check_horizontal_word_overlaps(pdf_path)
    if overlap_err:
        errors.append(overlap_err)
    elif word_overlaps:
        errors.append(
            f"Found {len(word_overlaps)} horizontal word overlap(s) (>1.5pt): {word_overlaps[:8]}"
        )

    report = {
        "pdf": pdf_path,
        "pages": num_pages,
        "sizeBytes": size_bytes,
        "sizeMiB": round(size_bytes / 1048576, 2),
        "embeddedFonts": sorted(embedded_fonts),
        "fallbackFonts": sorted(fallback_fonts),
        "wordOverlaps": len(word_overlaps) if word_overlaps is not None else -1,
        "outlineEntries": outline_stats["total"],
        "outlineByDepth": outline_stats["by_depth"],
        "invalidDests": outline_stats["invalid_dests"],
        "links": {
            "internalValid": internal_valid,
            "internalBroken": len(internal_broken),
            "externalUri": external_uri,
            "siteUrisChecked": site_uris_checked,
            "siteUriFragmentsChecked": site_uri_fragments_checked,
            "siteUrisBroken": len(site_uris_broken),
        },
    }
    print("[verify-pdf] Summary:\n" + json.dumps(report, indent=2))

    if errors:
        sys.stderr.write(f"\n[verify-pdf] FAILED with {len(errors)} error(s):\n")
        for err in errors:
            sys.stderr.write(f"  - {err}\n")
        return 1

    print("[verify-pdf] PASS — 0 errors.")
    return 0


def main():
    parser = argparse.ArgumentParser(description="Verify compiled PDF book structure and links.")
    parser.add_argument("pdfs", nargs="*", default=["dist/titan-programming-language.pdf"])
    parser.add_argument("--dist", default="dist", help="Built site dist/ directory for verifying same-site PDF URIs")
    parser.add_argument(
        "--site-origin",
        default="https://titan-lang.dev",
        help="Site origin whose PDF URIs must resolve against --dist",
    )
    parser.add_argument(
        "--min-outline",
        type=int,
        default=DEFAULT_MIN_OUTLINE_ENTRIES,
        help="Minimum required PDF outline bookmark count",
    )
    parser.add_argument(
        "--meta",
        default=None,
        help="Optional .generated/pdf-meta.json file to verify dynamic page count & byte size against",
    )
    args = parser.parse_args()

    exit_code = 0
    for target in args.pdfs:
        rc = verify_pdf(
            target,
            dist_dir=args.dist,
            site_origin=args.site_origin,
            min_outline=args.min_outline,
            meta_path=args.meta,
        )
        if rc != 0:
            exit_code = rc
    sys.exit(exit_code)


if __name__ == "__main__":
    main()
