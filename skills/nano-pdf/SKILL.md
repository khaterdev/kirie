---
name: nano-pdf
description: Lightweight PDF text extraction and page manipulation
emoji: "\U0001F4D1"
version: "1.0.0"
requires:
  bins:
    - pdftotext
  anyBins:
    - pdftk
    - qpdf
invocation:
  userInvocable: true
---

# Nano PDF (PDF Text Extraction & Utilities)

Lightweight PDF processing focused on fast text extraction and basic page manipulation. Unlike the `pdf-editor` skill which handles full PDF editing, this skill is optimized for quick read-only operations: pulling text out of PDFs, inspecting metadata, and simple split/merge tasks.

## Usage
- "Extract the text from report.pdf"
- "Get text from pages 5 through 10 of the manual"
- "How many pages is this PDF?"
- "Show me the metadata for this document"
- "Split this PDF into one file per page"
- "Merge these three PDFs into one"
- "Convert page 3 of the PDF to an image"

## How it works
Uses `pdftotext` (from poppler-utils) for text extraction and `pdftk` or `qpdf` for page manipulation.

### Text extraction
- All pages: `pdftotext input.pdf -` (outputs to stdout)
- Specific pages: `pdftotext -f 5 -l 10 input.pdf -` (pages 5-10)
- Layout-preserving: `pdftotext -layout input.pdf -`
- Raw text (no layout): `pdftotext -raw input.pdf -`

### Metadata
- Via pdftotext's companion: `pdfinfo input.pdf` (page count, title, author, creation date)

### Split and merge (pdftk)
- Split all pages: `pdftk input.pdf burst output page_%02d.pdf`
- Extract page range: `pdftk input.pdf cat 1-5 output first5.pdf`
- Merge files: `pdftk a.pdf b.pdf c.pdf cat output merged.pdf`

### Split and merge (qpdf)
- Extract pages: `qpdf input.pdf --pages . 1-5 -- output.pdf`
- Merge files: `qpdf --empty --pages a.pdf b.pdf c.pdf -- merged.pdf`

### Convert to image
- Using pdftoppm (poppler): `pdftoppm -png -f 3 -l 3 input.pdf page3` (produces page3-3.png)

## Setup
Install poppler-utils (provides `pdftotext`, `pdfinfo`, `pdftoppm`) and one of `pdftk` or `qpdf`:

### macOS
```
brew install poppler
brew install pdftk-java   # or: brew install qpdf
```

### Linux
```
sudo apt install poppler-utils
sudo apt install pdftk   # or: sudo apt install qpdf
```
