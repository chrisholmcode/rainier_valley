# Rendering & Output

After the HTML is written to `~/Downloads/rvfb_daily_summary_<YYYY-MM-DD>.html`, convert it to PDF with headless Chrome.

## Chrome headless command (macOS)

```bash
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --headless=new \
  --disable-gpu \
  --no-pdf-header-footer \
  --no-margins \
  --print-to-pdf="$HOME/Downloads/rvfb_daily_summary_<DATE>.pdf" \
  "file://$HOME/Downloads/rvfb_daily_summary_<DATE>.html"
```

Replace `<DATE>` with the target ISO date (`YYYY-MM-DD`) on both lines.

Notes:
- `--no-pdf-header-footer` removes the default browser header/footer (URL, page numbers).
- `--no-margins` lets the page's own padding control whitespace — the template applies `48px 24px` body padding, which is what the leadership template uses.
- The Rosetta warning ("Launching Chrome on Mac Silicon (arm64) from an x64 Node installation…") can be ignored when invoked from Bash directly.
- Chrome can sometimes emit `ERROR:chrome/browser/...` lines to stderr but still produce a valid PDF. Verify by file size (the styled report is ~300–500 KB) and by reading page 1.

## Output files

Both files land in the same directory the user reads from:

```
~/Downloads/rvfb_daily_summary_<YYYY-MM-DD>.html
~/Downloads/rvfb_daily_summary_<YYYY-MM-DD>.pdf
```

If files already exist for the target date, overwrite them — generating again means the user wants the latest data.

## Verification

Run a final `ls -la` on both, confirm the PDF is non-trivial in size (≥100 KB), and use the `Read` tool with `pages: "1-3"` to spot-check that the layout looks right before reporting back.

## Fallback if Chrome isn't installed

```bash
ls "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" 2>/dev/null
```

If missing, also check `wkhtmltopdf` (`which wkhtmltopdf`) or fall back to keeping just the HTML file and telling the user the PDF couldn't be rendered. Don't silently install anything.
